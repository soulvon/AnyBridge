# MITM Certificates

Generate with [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install                    # one-time: install local CA
mkcert server.codeium.com          # generates .pem + -key.pem
```

Place the generated files here:
- `server.codeium.com.pem`
- `server.codeium.com-key.pem`

These are gitignored — each developer generates their own.
