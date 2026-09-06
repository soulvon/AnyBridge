//! Defines available search services and configuration.
use super::{HtmlEngine, JsonEngine, SearchEngine};

macro_rules! html {
    ($id:literal, $url:literal, $item:literal, $title:literal, $link:literal, $snippet:literal) => {
        SearchEngine::from(HtmlEngine::new(
            $id,
            $url.into(),
            $item,
            $title,
            $link,
            $snippet,
        ))
    };
}

macro_rules! json {
    ($id:literal, $url:literal, $items:literal, $title:literal, $link:literal, $snippet:literal) => {
        SearchEngine::from(JsonEngine::new(
            $id,
            $url.into(),
            $items,
            $title,
            $link,
            $snippet,
            None,
        ))
    };
    ($id:literal, $url:literal, $items:literal, $title:literal, $link:literal, $snippet:literal, $template:literal) => {
        SearchEngine::from(JsonEngine::new(
            $id,
            $url.into(),
            $items,
            $title,
            $link,
            $snippet,
            Some($template),
        ))
    };
}

pub(crate) fn engines() -> Vec<SearchEngine> {
    vec![
        html!(
            "google",
            "https://www.google.com/search?q={query}&num=10",
            "div.MjjYud",
            "h3",
            "a",
            "div.VwiC3b"
        ),
        html!(
            "bing",
            "https://www.bing.com/search?q={query}&count=10",
            "li.b_algo",
            "h2",
            "h2 a",
            ".b_caption p"
        ),
        html!(
            "brave",
            "https://search.brave.com/search?q={query}&source=web",
            ".snippet",
            ".title",
            "a",
            ".snippet-description"
        ),
        html!(
            "duckduckgo",
            "https://html.duckduckgo.com/html/?q={query}",
            ".result",
            ".result__a",
            ".result__a",
            ".result__snippet"
        ),
        html!(
            "startpage",
            "https://www.startpage.com/sp/search?query={query}",
            ".w-gl__result",
            ".w-gl__result-title",
            "a.w-gl__result-title",
            ".w-gl__description"
        ),
        html!(
            "yahoo",
            "https://search.yahoo.com/search?p={query}",
            "div.dd.algo",
            "h3.title",
            "h3.title a",
            ".compText"
        ),
        html!(
            "mojeek",
            "https://www.mojeek.com/search?q={query}",
            "ul.results-standard > li",
            "h2",
            "h2 a",
            ".s"
        ),
        html!(
            "qwant",
            "https://www.qwant.com/?q={query}&t=web",
            "article",
            "h2",
            "a",
            "p"
        ),
        html!(
            "ecosia",
            "https://www.ecosia.org/search?q={query}",
            "article",
            "h2",
            "a",
            "p"
        ),
        html!(
            "yandex",
            "https://yandex.com/search/?text={query}",
            ".serp-item",
            "h2",
            "h2 a",
            ".OrganicTextContentSpan"
        ),
        html!(
            "baidu",
            "https://www.baidu.com/s?wd={query}",
            "div.result",
            "h3",
            "h3 a",
            ".c-abstract"
        ),
        html!(
            "sogou",
            "https://www.sogou.com/web?query={query}",
            ".vrwrap",
            "h3",
            "h3 a",
            ".str_info"
        ),
        html!(
            "so360",
            "https://www.so.com/s?q={query}",
            ".res-list",
            "h3",
            "h3 a",
            ".res-desc"
        ),
        html!(
            "naver",
            "https://search.naver.com/search.naver?query={query}",
            ".total_wrap",
            ".total_tit",
            "a.total_tit",
            ".dsc_txt"
        ),
        html!(
            "seznam",
            "https://search.seznam.cz/?q={query}",
            ".Result",
            ".Result-title",
            "a.Result-title",
            ".Result-description"
        ),
        json!(
            "wikipedia",
            "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch={query}&srlimit=10&format=json",
            "/query/search",
            "/title",
            "/pageid",
            "/snippet",
            "https://en.wikipedia.org/?curid={value}"
        ),
        html!(
            "github",
            "https://github.com/search?q={query}&type=repositories",
            "[data-testid='results-list'] > div",
            "h3",
            "h3 a",
            "p"
        ),
        json!(
            "stackoverflow",
            "https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&q={query}&pagesize=10&filter=withbody",
            "/items",
            "/title",
            "/link",
            "/body"
        ),
        json!(
            "crates_io",
            "https://crates.io/api/v1/crates?q={query}&per_page=10",
            "/crates",
            "/name",
            "/id",
            "/description",
            "https://crates.io/crates/{value}"
        ),
        json!(
            "npm",
            "https://registry.npmjs.org/-/v1/search?text={query}&size=10",
            "/objects",
            "/package/name",
            "/package/links/npm",
            "/package/description"
        ),
        html!(
            "pypi",
            "https://pypi.org/search/?q={query}",
            ".package-snippet",
            ".package-snippet__name",
            "a.package-snippet",
            ".package-snippet__description"
        ),
        html!(
            "arxiv",
            "https://arxiv.org/search/?query={query}&searchtype=all",
            "li.arxiv-result",
            "p.title",
            "p.list-title a",
            "span.abstract-full"
        ),
        json!(
            "crossref",
            "https://api.crossref.org/works?query={query}&rows=10",
            "/message/items",
            "/title/0",
            "/URL",
            "/abstract"
        ),
    ]
}
