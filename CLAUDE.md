# Notes for Claude

- Work directly on `main`: commit and push there, no feature branches or pull requests.
- Every push to `main` publishes the extension: GitHub Actions rebuilds `wrangle-tabs.zip` on the `latest` release, which goodgriefgnome.github.io links to.
- Run `npm test` and `npm run build` before pushing.
