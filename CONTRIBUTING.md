# Contributing to Lectio Sync

Thank you for helping other students. Contributions are welcome for browser compatibility, parser maintenance, accessibility, translations, tests, documentation, and security improvements.

## Before opening a change

1. Search existing issues and pull requests to avoid duplicate work.
2. For a substantial feature or behavior change, open an issue first so the privacy and security impact can be discussed.
3. Never include real student data, Lectio HTML captured from a real account, cookies, MitID details, OAuth tokens, keys, or client secrets.
4. Report vulnerabilities privately as described in `SECURITY.md` instead of opening a public issue.

## Development

Requirements are Node.js 20 or later. Safari work additionally requires macOS and Xcode.

```sh
npm ci
npm run verify
```

Changes should include tests for new behavior. Parser fixtures must be synthetic or irreversibly sanitized. Keep browser permissions and host access as narrow as possible.

## Pull requests

- Explain the student-facing problem and the chosen solution.
- List the browsers tested.
- Call out changes to permissions, authentication, stored data, or network destinations.
- Update `PRIVACY.md`, `SECURITY.md`, and release documentation when behavior changes.
- Confirm `npm run verify` passes.

By contributing, you agree that your contribution is licensed under the project's MIT License.
