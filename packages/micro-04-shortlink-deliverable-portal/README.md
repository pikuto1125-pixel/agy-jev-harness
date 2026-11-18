# shortlink-deliverable-portal

Turn a folder of finished work (HTML reports, Markdown notes, PDFs, text files) into a small static site with short, pure-ASCII links that are easy to paste into chat apps and open on a phone, even when the source file names are Japanese.

- Each deliverable gets a deterministic route `/m/id/<10hex>.html`, where `<10hex>` is the first 10 hex characters of the SHA-256 of its normalised relative path.
- The build also writes a searchable, responsive, self-contained `index.html` (inline CSS and JS, client-side filter, no CDN, no external fonts) and a `manifest.json` that maps each id back to the original path.
- Zero dependencies, Node 20 or newer, MIT licensed, offline, deterministic. Part of the Jev Harness family (see the end).

## What it does

```text
<inDir>/report.html            ->  <outDir>/m/id/bcb3d7751f.html        (copy of the HTML)
<inDir>/notes/メモ.md          ->  <outDir>/m/id/61de69c60d.html        (redirect stub)
                                   <outDir>/m/f/61de69c60d.md           (the file, ASCII name)
                                   <outDir>/index.html                  (searchable index)
                                   <outDir>/manifest.json               (id -> original path, title, sha256)
```

- **Why ASCII:** a link such as `https://host/m/id/61de69c60d.html` survives chat apps, QR codes and SMS without percent-encoding. Titles and original paths are shown on the index page as text; every `href` and every byte of `index.html` is ASCII (non-ASCII text is written as numeric character references).
- **Id rule:** normalise the relative path (forward slashes, no leading `./`, no duplicate slashes, Unicode NFC), then `sha256(utf8).hex.slice(0, 10)`.
- **Collisions:** if two different paths share a 10-hex id, paths are processed in code-point order; the first keeps the 10-hex id and later ones take 12, 14, ... hex characters of the same hash. Identical normalised paths (for example NFC and NFD spellings of one name) are rehashed with a `#n` suffix. The result is deterministic for a given set of files; adding a file that collides with an existing id can change which of the two keeps the short id.
- **Safety:** rejects `..` segments, absolute paths (POSIX, drive letter, UNC), NUL bytes and empty paths; rejects symlinked files that resolve outside the input directory; does not follow symlinked or junction directories; skips dot-directories; and never writes outside `<outDir>`.
- **Titles:** HTML `<title>` then `<h1>`; Markdown front-matter `title:` then the first heading; text files use the first non-empty line; PDF uses the `/Title` entry when it is stored as plain text; otherwise the file name without extension.

## 30-second quickstart

```bash
cd micro-04-shortlink-deliverable-portal
mkdir -p deliverables/notes
printf '<html><head><title>Q3 Report</title></head><body>hi</body></html>' > deliverables/report.html
printf '# Meeting notes\n' > deliverables/notes/meeting.md

node bin/shortlink-portal.mjs build deliverables site --title "Deliverables"
# built 2 page(s) into site
# index: index.html  manifest: manifest.json

node bin/shortlink-portal.mjs verify site
# OK (2 entries)

ID=$(node -p "Object.keys(JSON.parse(fs.readFileSync('site/manifest.json','utf8')).ids)[0]")
node bin/shortlink-portal.mjs resolve site/manifest.json "/m/id/$ID.html"
# prints the original relative path
```

Open `site/index.html` in a browser to search and open the pages, or publish the `site` directory to any static host. The shortlinks are `https://<your-host>/m/id/<10hex>.html`; the index uses relative links, so it works under any base path.

## CLI reference

```text
shortlink-portal build <inDir> <outDir> [--title T] [--ext .html,.md,.pdf,.txt] [--html-mode copy|redirect] [--list file] [--force] [--json]
shortlink-portal resolve <manifest> <id> [--json]
shortlink-portal verify <outDir> [--json]
```

| Command / option | Meaning |
| --- | --- |
| `build` | Scan `<inDir>`, write `m/id/*.html`, `m/f/*`, `index.html`, `manifest.json` into `<outDir>`. `<outDir>` may sit inside `<inDir>` (it is skipped when scanning) but may not equal it. |
| `--ext` | Comma-separated extensions to include (default `.html .htm .md .pdf .txt`). Each must be ASCII, up to 8 characters. |
| `--html-mode copy` | Default. The route page is a byte-for-byte copy of the HTML file. Relative assets next to it will not resolve; use self-contained HTML or `redirect`. |
| `--html-mode redirect` | The HTML file is stored under `m/f/` and the route page is a redirect stub. |
| `--list file` | Read one relative path per line instead of walking `<inDir>`. Unsafe entries are rejected and reported. |
| `--force` | Allow a build into a non-empty output directory that lacks `manifest.json`. |
| `--title T` | Title of the index page (default "Deliverables"). |
| `resolve` | Print the original path for an id. Accepts `<hex>`, `<hex>.html`, `/m/id/<hex>.html` or a full URL (query and fragment ignored). |
| `verify` | Check a built portal: manifest, id derivation for 10-hex ids, route and file existence, SHA-256 of each file, ASCII-only URLs, files in `m/id/` and `m/f/` that are not in the manifest, and that `index.html` is ASCII with no external `src`/`href`. |
| `--json` | Machine-readable output. |
| `-h`, `--help`, `--version` | Usage; prints `1.0.0`. |

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success. |
| 1 | `build` rejected at least one unsafe path (the safe ones are still built); `resolve` did not find the id; `verify` found issues. |
| 2 | Bad argument, unknown subcommand, unreadable input, missing directory. |

## JavaScript API

```js
import { buildPortal, resolveId, verifyPortal, idFor } from 'shortlink-deliverable-portal';

const result = buildPortal('./deliverables', './site', { title: 'Deliverables' });
console.log(result.count, result.skipped);
console.log(idFor('notes/メモ.md'));                     // 10 hex characters
console.log(resolveId('./site/manifest.json', '/m/id/' + idFor('report.html') + '.html')?.path);
console.log(verifyPortal('./site').ok);
```

| Export | Purpose |
| --- | --- |
| `buildPortal(inDir, outDir, {title, extensions, htmlMode, files, fullHash, force})` | Build everything; returns `{ok, count, entries, skipped, index, manifest}`. `files` is an explicit relative-path list; `fullHash` overrides the hash (used by tests to force collisions). |
| `resolveId(manifestPathOrObject, id)` | Entry `{id, path, title, ext, bytes, sha256, route, file}` or `null`. |
| `verifyPortal(outDir)` | `{ok, count, issues: [{code, id?, message}]}`. |
| `idFor(relPath)`, `normaliseRelPath(p)`, `validateRelPath(p)` | Id and path helpers; `validateRelPath` returns `{ok, reason}` with reason `nul_byte`, `empty`, `absolute_path` or `parent_traversal`. |
| `assignIds(paths, {fullHash})` | Collision-safe ids as a `Map`. |
| `extractTitle(text, ext, relPath)` | Title extraction. |
| `scanInputs(inDir, opts)` | `{files, skipped}` without writing anything. |
| `renderIndexHtml(entries, {title})`, `renderStub(entry, target)` | Page renderers. |
| `VERSION`, `DEFAULT_EXTENSIONS` | Constants. |

### `manifest.json` schema

```json
{
  "version": 1,
  "generator": "shortlink-deliverable-portal 1.0.0",
  "htmlMode": "copy",
  "count": 2,
  "ids": {
    "61de69c60d": {
      "path": "notes/メモ.md", "title": "...", "ext": ".md", "bytes": 18,
      "sha256": "<64 hex of the file>", "route": "m/id/61de69c60d.html", "file": "m/f/61de69c60d.md"
    }
  }
}
```

`file` is `null` for HTML copied as the route page. The manifest is ASCII-only JSON (non-ASCII characters are `\u` escapes), so `JSON.parse` returns the original Japanese path. Skipped paths are reported by `build`, not stored in the manifest.

## Limits and honest caveats

- It is a static builder. It does not host, shorten across domains, expire links or protect them: anyone who has a link can open the page, and the 10-hex id is derived from the path, so it is guessable by someone who knows the path. Do not publish confidential files.
- Markdown files are not rendered. The route page redirects to the raw `.md` file, which some phones download instead of display. PDFs open in the browser's viewer where supported.
- HTML copies keep their bytes unchanged, including their own encoding declaration and any external references they contain. The "no external resources" guarantee applies to the generated index and stubs, not to your HTML.
- PDF titles are read from a plain-text `/Title (...)` entry only; compressed or encoded metadata falls back to the file name.
- File lookup uses the NFC-normalized relative path. A decomposed name is skipped if the filesystem cannot resolve the normalized name.
- Symlink-escape detection depends on what the OS and Node report; on Windows, creating file symlinks may need elevated rights, and directory links are skipped rather than followed.
- Rebuilding an existing portal updates matching files and removes stale files directly in `m/id/` and `m/f/`. A non-empty directory without `manifest.json` requires `--force` (API `force: true`).
- The id is 40 bits of SHA-256. Collisions are handled, but the id is a locator, not a security token.

## Part of the family

- Tier 1 (free, MIT): this package, `micro-02-retro-failure-linter`, `micro-03-cognitive-wiki-and-u-gate`, and the Free Pack `progressive-context-slicer`.
- Tier 2: paid micro-packs.
- Tier 3: Master Edition "Autonomous HQ OS".
- Public companion repo: `agy-jev-harness`.

## License

MIT, see `LICENSE`.
