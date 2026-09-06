//! Encodes and decodes Cursor JSON streaming payloads.
use crate::{Error, Result};

#[derive(Debug, PartialEq)]
pub(crate) enum StringFieldEvent {
    Delta { name: String, text: String },
    End { name: String },
}

#[derive(Default)]
pub(crate) struct JsonStringFields {
    state: State,
    key: String,
    string: JsonString,
    skipped: SkippedValue,
}

#[derive(Default)]
enum State {
    #[default]
    Object,
    Key,
    KeyString,
    Colon,
    Value,
    ValueString,
    SkipValue,
    AfterValue,
    Done,
}

impl JsonStringFields {
    pub fn push(&mut self, input: &str) -> Result<Vec<StringFieldEvent>> {
        let mut events = Vec::new();
        for character in input.chars() {
            self.consume(character, &mut events)?;
        }
        Ok(events)
    }

    fn consume(&mut self, character: char, events: &mut Vec<StringFieldEvent>) -> Result<()> {
        match self.state {
            State::Object => match character {
                '{' => self.state = State::Key,
                value if value.is_whitespace() => {}
                _ => return Err(protocol("tool arguments must start with an object")),
            },
            State::Key => match character {
                '"' => {
                    self.key.clear();
                    self.string.clear();
                    self.state = State::KeyString;
                }
                '}' => self.state = State::Done,
                value if value.is_whitespace() => {}
                _ => return Err(protocol("expected a tool argument name")),
            },
            State::KeyString => match self.string.push(character)? {
                StringStep::Text(text) => self.key.push_str(&text),
                StringStep::End => self.state = State::Colon,
                StringStep::Pending => {}
            },
            State::Colon => match character {
                ':' => self.state = State::Value,
                value if value.is_whitespace() => {}
                _ => return Err(protocol("expected ':' after tool argument name")),
            },
            State::Value => match character {
                '"' => {
                    self.string.clear();
                    self.state = State::ValueString;
                }
                value if value.is_whitespace() => {}
                value => {
                    self.skipped.start(value);
                    self.state = State::SkipValue;
                }
            },
            State::ValueString => match self.string.push(character)? {
                StringStep::Text(text) => push_delta(events, &self.key, text),
                StringStep::End => {
                    events.push(StringFieldEvent::End {
                        name: self.key.clone(),
                    });
                    self.state = State::AfterValue;
                }
                StringStep::Pending => {}
            },
            State::SkipValue => {
                if let Some(terminal) = self.skipped.push(character) {
                    self.state = match terminal {
                        ',' => State::Key,
                        '}' => State::Done,
                        _ => return Err(protocol("invalid skipped JSON value terminator")),
                    };
                }
            }
            State::AfterValue => match character {
                ',' => self.state = State::Key,
                '}' => self.state = State::Done,
                value if value.is_whitespace() => {}
                _ => return Err(protocol("expected ',' after tool argument value")),
            },
            State::Done if character.is_whitespace() => {}
            State::Done => return Err(protocol("data after tool arguments object")),
        }
        Ok(())
    }
}

fn push_delta(events: &mut Vec<StringFieldEvent>, name: &str, text: String) {
    if let Some(StringFieldEvent::Delta {
        name: previous_name,
        text: previous_text,
    }) = events.last_mut()
    {
        if previous_name == name {
            previous_text.push_str(&text);
            return;
        }
    }
    events.push(StringFieldEvent::Delta {
        name: name.into(),
        text,
    });
}

#[derive(Default)]
struct JsonString {
    escape: String,
}

enum StringStep {
    Text(String),
    End,
    Pending,
}

impl JsonString {
    fn clear(&mut self) {
        self.escape.clear();
    }

    fn push(&mut self, character: char) -> Result<StringStep> {
        if self.escape.is_empty() {
            return match character {
                '"' => Ok(StringStep::End),
                '\\' => {
                    self.escape.push(character);
                    Ok(StringStep::Pending)
                }
                value if value < '\u{20}' => Err(protocol("control character in JSON string")),
                value => Ok(StringStep::Text(value.to_string())),
            };
        }

        self.escape.push(character);
        let complete = match self.escape.as_bytes() {
            [b'\\', b'u', a, b, c, d]
                if [a, b, c, d].iter().all(|value| value.is_ascii_hexdigit()) =>
            {
                let code = u16::from_str_radix(&self.escape[2..], 16)
                    .map_err(|_| protocol("invalid JSON unicode escape"))?;
                !(0xD800..=0xDBFF).contains(&code)
            }
            [b'\\', b'u', ..] if self.escape.len() < 6 => false,
            [b'\\', b'u', a, b, c, d, b'\\', b'u', e, f, g, h]
                if [a, b, c, d, e, f, g, h]
                    .iter()
                    .all(|value| value.is_ascii_hexdigit()) =>
            {
                true
            }
            [b'\\', b'u', ..] if self.escape.len() < 12 => false,
            [b'\\', b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't'] => true,
            [b'\\'] => false,
            _ => return Err(protocol("invalid JSON string escape")),
        };
        if !complete {
            return Ok(StringStep::Pending);
        }
        let quoted = format!("\"{}\"", self.escape);
        let decoded: String = serde_json::from_str(&quoted)
            .map_err(|error| protocol(&format!("invalid JSON string escape: {error}")))?;
        self.escape.clear();
        Ok(StringStep::Text(decoded))
    }
}

#[derive(Default)]
struct SkippedValue {
    depth: usize,
    string: bool,
    escaped: bool,
}

impl SkippedValue {
    fn start(&mut self, first: char) {
        *self = Self::default();
        self.observe(first);
    }

    fn push(&mut self, character: char) -> Option<char> {
        if !self.string && self.depth == 0 && matches!(character, ',' | '}') {
            return Some(character);
        }
        self.observe(character);
        None
    }

    fn observe(&mut self, character: char) {
        if self.string {
            if self.escaped {
                self.escaped = false;
            } else if character == '\\' {
                self.escaped = true;
            } else if character == '"' {
                self.string = false;
            }
            return;
        }
        match character {
            '"' => self.string = true,
            '{' | '[' => self.depth += 1,
            '}' | ']' => self.depth = self.depth.saturating_sub(1),
            _ => {}
        }
    }
}

fn protocol(message: &str) -> Error {
    Error::Protocol(message.into())
}
