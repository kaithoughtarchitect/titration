# Security Policy

## Reporting a vulnerability

Please report security issues privately, not as a public GitHub issue.

Use **GitHub Security Advisories**: go to this repository's **Security** tab
and click **"Report a vulnerability."** That opens a private draft advisory
visible only to you and the maintainer, so we can discuss and fix the issue
before any public disclosure.

Please include:

- what you found and why it's a security issue (not just a bug),
- steps to reproduce it,
- the version/commit you tested against,
- any suggested fix, if you have one.

Titration is maintained by one person, so please allow up to a week for an
initial response.

## Scope notes

Titration runs entirely on your own machine, talking to your own database and
whichever judge providers you configure. A few things worth knowing when
thinking about its attack surface:

- The local judge picker binds to `127.0.0.1` only — it is never reachable
  from another machine on your network.
- API keys and connection strings live in your own `.env` file (gitignored;
  never committed) and are read from the environment. Titration does not
  transmit them anywhere except to the provider each key is for.
- Error text returned through an MCP tool call is passed through a redaction
  pass (`lib/tool-error-redaction-core.ts`) that strips secrets and local file
  paths before the text reaches a caller or a transcript.
- Titration never clones or executes your project's code. It receives
  declared outputs over MCP and grades those; it does not pull or run your
  repository.

If you're unsure whether something you found is in scope, report it anyway —
we would rather triage a false positive than miss a real issue.
