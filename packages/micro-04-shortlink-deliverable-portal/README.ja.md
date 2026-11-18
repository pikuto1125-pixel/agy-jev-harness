# shortlink-deliverable-portal

完成した成果物(HTML レポート、Markdown メモ、PDF、テキスト)のフォルダを、短くて ASCII だけのリンクを持つ小さな静的サイトに変換します。元のファイル名が日本語でも、チャットアプリに貼りやすく、スマホでも開きやすいリンクになります。

- 各成果物には、決定的なルート `/m/id/<10hex>.html` が割り当てられます。`<10hex>` は、正規化した相対パスの SHA-256 の先頭 10 桁(16 進)です。
- 同時に、検索できてレスポンシブな、単体で完結する `index.html`(CSS と JS はインライン、クライアント側の絞り込み、CDN なし、外部フォントなし)と、ID から元のパスへ戻す `manifest.json` を出力します。
- 依存パッケージなし、Node 20 以上、MIT ライセンス、オフライン、決定的に動作します。Jev Harness ファミリーの一部です(末尾参照)。

## できること

```text
<inDir>/report.html            ->  <outDir>/m/id/bcb3d7751f.html        (HTML のコピー)
<inDir>/notes/メモ.md          ->  <outDir>/m/id/61de69c60d.html        (リダイレクト用スタブ)
                                   <outDir>/m/f/61de69c60d.md           (ASCII 名の実体ファイル)
                                   <outDir>/index.html                  (検索できる一覧)
                                   <outDir>/manifest.json               (id -> 元のパス・タイトル・sha256)
```

- **ASCII にする理由:** `https://host/m/id/61de69c60d.html` のようなリンクは、チャットアプリ、QR コード、SMS でもパーセントエンコードなしで壊れずに届きます。タイトルと元のパスは一覧ページに文字として表示しますが、すべての `href` と `index.html` の全バイトは ASCII です(非 ASCII の文字は数値文字参照で書きます)。
- **ID の規則:** 相対パスを正規化(スラッシュ区切り、先頭の `./` 除去、連続スラッシュの圧縮、Unicode NFC)し、`sha256(utf8).hex.slice(0, 10)` を取ります。
- **衝突時:** 異なるパスの 10 桁 ID が一致した場合、パスをコードポイント順に処理し、先のものが 10 桁を保持します。後のものは同じハッシュの 12 桁、14 桁…と延ばします。正規化後に同一のパス(たとえば同じ名前の NFC と NFD)は、`#n` を付けて再ハッシュします。同じファイル集合なら結果は常に同じですが、既存の ID と衝突するファイルを追加すると、どちらが短い ID を保持するかが変わることがあります。
- **安全性:** `..` を含むパス、絶対パス(POSIX、ドライブ文字、UNC)、NUL バイト、空のパスを拒否します。入力ディレクトリの外を指すシンボリックリンクのファイルも拒否し、シンボリックリンクやジャンクションのディレクトリはたどりません。ドット始まりのディレクトリは除外し、`<outDir>` の外には書き込みません。
- **タイトル:** HTML は `<title>`、なければ `<h1>`。Markdown は front matter の `title:`、なければ最初の見出し。テキストは最初の空でない行。PDF はプレーンテキストで保存された `/Title` エントリ。どれもなければ拡張子を除いたファイル名です。

## 30 秒クイックスタート

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
# 元の相対パスを表示
```

`site/index.html` をブラウザで開けば、検索してページを開けます。`site` ディレクトリは、任意の静的ホスティングにそのまま公開できます。短縮リンクは `https://<あなたのホスト>/m/id/<10hex>.html` で、一覧は相対リンクなので、どのベースパスの下でも動きます。

## CLI リファレンス

```text
shortlink-portal build <inDir> <outDir> [--title T] [--ext .html,.md,.pdf,.txt] [--html-mode copy|redirect] [--list file] [--force] [--json]
shortlink-portal resolve <manifest> <id> [--json]
shortlink-portal verify <outDir> [--json]
```

| コマンド・オプション | 意味 |
| --- | --- |
| `build` | `<inDir>` を走査し、`m/id/*.html`、`m/f/*`、`index.html`、`manifest.json` を `<outDir>` に書き出す。`<outDir>` を `<inDir>` の中に置くことはできる(走査時に除外される)が、同一にはできない |
| `--ext` | 対象にする拡張子のカンマ区切り(既定は `.html .htm .md .pdf .txt`)。各拡張子は ASCII で 8 文字以内 |
| `--html-mode copy` | 既定。ルートのページは HTML ファイルのバイト単位のコピー。隣にある相対パスの素材は解決されないため、単体で完結する HTML か `redirect` を使う |
| `--html-mode redirect` | HTML ファイルは `m/f/` に保存し、ルートのページはリダイレクト用スタブにする |
| `--list file` | `<inDir>` を走査せず、1 行 1 つの相対パスを読み込む。安全でない項目は拒否して報告する |
| `--force` | `manifest.json` がない空でない出力ディレクトリへの構築を許可する |
| `--title T` | 一覧ページのタイトル(既定は "Deliverables") |
| `resolve` | ID から元のパスを表示する。`<hex>`、`<hex>.html`、`/m/id/<hex>.html`、完全な URL(クエリとフラグメントは無視)を受け付ける |
| `verify` | 構築済みポータルを検査する。マニフェスト、10 桁 ID の導出、ルートとファイルの存在、各ファイルの SHA-256、URL が ASCII のみか、マニフェストにない `m/id/` と `m/f/` 内のファイル、`index.html` が ASCII で外部の `src`/`href` がないこと |
| `--json` | 機械可読の出力 |
| `-h`, `--help`, `--version` | 使い方。`1.0.0` を表示 |

### 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | `build` が安全でないパスを 1 件以上拒否した(安全なものは構築される)、`resolve` が ID を見つけられない、`verify` が問題を検出した |
| 2 | 引数不正、不明なサブコマンド、読み込めない入力、ディレクトリがない |

## JavaScript API

```js
import { buildPortal, resolveId, verifyPortal, idFor } from 'shortlink-deliverable-portal';

const result = buildPortal('./deliverables', './site', { title: 'Deliverables' });
console.log(result.count, result.skipped);
console.log(idFor('notes/メモ.md'));                     // 16 進 10 桁
console.log(resolveId('./site/manifest.json', '/m/id/' + idFor('report.html') + '.html')?.path);
console.log(verifyPortal('./site').ok);
```

| エクスポート | 役割 |
| --- | --- |
| `buildPortal(inDir, outDir, {title, extensions, htmlMode, files, fullHash, force})` | すべてを構築して `{ok, count, entries, skipped, index, manifest}` を返す。`files` は相対パスの明示リスト、`fullHash` はハッシュの差し替え(テストで衝突を起こすために使う) |
| `resolveId(manifestPathOrObject, id)` | エントリ `{id, path, title, ext, bytes, sha256, route, file}` または `null` |
| `verifyPortal(outDir)` | `{ok, count, issues: [{code, id?, message}]}` |
| `idFor(relPath)`、`normaliseRelPath(p)`、`validateRelPath(p)` | ID とパスの補助関数。`validateRelPath` は `{ok, reason}` を返し、reason は `nul_byte`、`empty`、`absolute_path`、`parent_traversal` のいずれか |
| `assignIds(paths, {fullHash})` | 衝突を避けた ID を `Map` で返す |
| `extractTitle(text, ext, relPath)` | タイトルの抽出 |
| `scanInputs(inDir, opts)` | 何も書き込まずに `{files, skipped}` を返す |
| `renderIndexHtml(entries, {title})`、`renderStub(entry, target)` | ページの生成 |
| `VERSION`, `DEFAULT_EXTENSIONS` | 定数 |

### `manifest.json` のスキーマ

```json
{
  "version": 1,
  "generator": "shortlink-deliverable-portal 1.0.0",
  "htmlMode": "copy",
  "count": 2,
  "ids": {
    "61de69c60d": {
      "path": "notes/メモ.md", "title": "...", "ext": ".md", "bytes": 18,
      "sha256": "<ファイルの 64 桁 16 進>", "route": "m/id/61de69c60d.html", "file": "m/f/61de69c60d.md"
    }
  }
}
```

HTML をルートのページとしてコピーした場合、`file` は `null` です。マニフェストは ASCII だけの JSON(非 ASCII 文字は `\u` エスケープ)なので、`JSON.parse` すると元の日本語パスに戻ります。スキップされたパスは `build` の出力で報告され、マニフェストには保存されません。

## 限界と注意点

- これは静的ファイルの生成ツールです。ホスティング、ドメインをまたぐ短縮、リンクの期限切れ、アクセス制限は行いません。リンクを知っている人は誰でもページを開けます。また ID はパスから導出されるため、パスを知っている人には推測できます。機密ファイルは公開しないでください。
- Markdown は描画しません。ルートのページは生の `.md` ファイルへリダイレクトするため、スマホによっては表示せずにダウンロードされます。PDF は、対応していればブラウザのビューアで開きます。
- HTML のコピーはバイト列を変更しません。文字コード宣言や、HTML 自身が持つ外部参照もそのままです。「外部リソースなし」が保証されるのは、生成される一覧とスタブであり、あなたの HTML ではありません。
- PDF のタイトルは、プレーンテキストの `/Title (...)` エントリだけから読みます。圧縮・エンコードされたメタデータの場合は、ファイル名にフォールバックします。
- NFC 正規化済みの相対パスでファイルを探します。ファイルシステムが正規化済みの名前を解決できない場合はスキップします。
- シンボリックリンクの検出は、OS と Node が報告する内容に依存します。Windows ではファイルのシンボリックリンク作成に管理者権限が必要なことがあり、ディレクトリのリンクはたどらずにスキップします。
- 既存のポータルに再構築すると、同名のファイルを上書きし、`m/id/` と `m/f/` の直下にある不要になったファイルを削除します。`manifest.json` がない空でない出力先には `--force`（API では `force: true`）が必要です。
- ID は SHA-256 の 40 ビットです。衝突は処理しますが、ID は場所を示す識別子であり、セキュリティ用のトークンではありません。

## ファミリーでの位置づけ

- Tier 1(無料・MIT): 本パッケージ、`micro-02-retro-failure-linter`、`micro-03-cognitive-wiki-and-u-gate`、Free Pack の `progressive-context-slicer`。
- Tier 2: 有料のマイクロパック。
- Tier 3: Master Edition「Autonomous HQ OS」。
- 公開コンパニオンリポジトリ: `agy-jev-harness`。

## ライセンス

MIT。`LICENSE` を参照してください。
