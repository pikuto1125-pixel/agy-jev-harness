# cognitive-wiki-and-u-gate

AI エージェントと人間が共同で書き込む Markdown ナレッジベースのための、2 つの小さな検査ツールです。

1. **Wiki リンター**(`wiki-ugate lint <dir>`): 1 ファイル 1 役割、短い入口ページ、リンク切れなし、孤立ページなし。
2. **[U] 未検証主張ゲート**(`wiki-ugate ugate <file|dir>`): 未解決の `[U]` マーカー、根拠のない推定値、出典のない統計が残っている間は、CI やリリースを止めます。

依存パッケージなし、Node 20 以上、MIT ライセンス、オフライン、決定的に動作します。Jev Harness ファミリーの一部です(末尾参照)。

## 検査する内容

### Wiki リンター

| ルール | 指摘する内容 |
| --- | --- |
| `multi_role` | 1 ファイルが複数の異なる役割を宣言している。front matter の `role:` / `roles:`(単一値、カンマ区切り、`[a, b]`、YAML リスト)と、`## Role: x` 見出しが対象。同じ役割の重複は問題なし |
| `entrypoint_too_long` | 入口ファイル(`index.md`、`README.md`、`root.md`。階層を問わず、大文字小文字は区別しない)が 200 行を超えている(`--max-lines` で変更可) |
| `broken_link` | 相対 Markdown リンク、画像、参照定義(`[x]: path`)、`[[wikilink]]` の指す先が存在しない。外部 URL(`https:`、`mailto:` など)と `#アンカー` は検査しない。コードスパンとコードブロック内は無視 |
| `orphan` | ルートの入口ページからリンクをたどって到達できない Markdown ページ |
| `missing_entrypoint` | wiki のルートに `index.md`、`README.md`、`root.md` がない(`--entry` で指定可)。この場合、孤立ページの検査は行いません |

リンクの規則: リンク先はリンク元ファイルからの相対で解決します。`/x.md` は wiki ルートからの相対です。`%XX` エスケープは復号され、`.md` の省略も試します。ディレクトリへのリンクは、その中の index / README / root ページに解決します。大文字小文字は区別して比較するため、Windows と Linux で結果が変わりません。`[[名前|表示名#見出し]]` は、ファイル名(拡張子なし)またはパスの末尾で、大文字小文字を区別せずに照合します。

### [U] ゲート

| ルール | 指摘する内容 |
| --- | --- |
| `unresolved_u` | 解決されていない `[U]` マーカー(`[U?]`、`[U: メモ]` も含む) |
| `bad_resolution` | 出典が空の `[U→verified: ]`、または `verified:` のない矢印形式 |
| `bare_estimate` | 近くに根拠がないのに事実のように書かれた推定値。"about 40% faster"、"roughly $200"、「約40%」など |
| `unsourced_stat` | 近くに根拠がない、パーセント、ドル・ユーロ・ポンド・円の金額、"N users/customers/downloads"(「3000人」「万人」「円」も含む)など |

解決済みの主張は `[U→verified: <出典>]` と書きます(ASCII の `[U->verified: <出典>]` も使えます)。これは許可され、`resolved` に数えられます。

「近くの根拠」とは、同じ行、または上下 `--window` 行以内(既定 1)にある、URL、Markdown リンク、`[source: ...]`、`[src: ...]`、`[cite: ...]`、脚注 `[^1]`、`Source:`、`(source ...)`、出典のいずれかです。`[est]` と `[U]` のタグは、その行にだけ効きます。

コードブロックとインラインコードは、`--include-code` を付けない限り検査しません。そのため、ドキュメントの中で `[U]` という書き方を説明しても失敗しません。

## 30 秒クイックスタート

```bash
cd micro-03-cognitive-wiki-and-u-gate
mkdir -p demo/ops
printf '# Home\n- [Runbook](ops/runbook.md)\n- [Missing](ops/gone.md)\n' > demo/index.md
printf -- '---\nrole: runbook\n---\n# Runbook\nRestarts are about 40%% faster.\nWe serve 5,000 users [U].\n' > demo/ops/runbook.md
printf '# Stray\n' > demo/stray.md

node bin/wiki-ugate.mjs lint demo
node bin/wiki-ugate.mjs ugate demo
```

出力(抜粋。どちらも終了コード 1):

```text
wiki lint: demo (3 pages, entry index.md)
index.md:3  broken_link  broken link "ops/gone.md": target does not exist
stray.md:1  orphan  not reachable from index.md; link it from an index or remove it
FAIL: 2 finding(s) {"broken_link":1,"orphan":1}

u-gate: demo (3 file(s))
ops/runbook.md:5:14  bare_estimate  estimate "about 40%" is stated as fact; add a source link, [source: ...], or tag it [est] or [U]
ops/runbook.md:6:22  unresolved_u  unresolved [U] marker; verify it and replace with [U→verified: <source>] or remove the claim
FAIL: 2 finding(s) {"bare_estimate":1,"unresolved_u":1}
```

CI では `node bin/wiki-ugate.mjs ugate docs/ && node bin/wiki-ugate.mjs lint docs/` のように実行します。どちらかが 0 以外で終わればジョブは失敗します。

## CLI リファレンス

```text
wiki-ugate lint <dir>        [--json] [--entry file] [--max-lines N] [--ignore prefix]
wiki-ugate ugate <file|dir>  [--json] [--window N] [--include-code] [--ignore prefix]
```

| オプション | 対象 | 意味 |
| --- | --- | --- |
| `--json` | 両方 | テキストの代わりに JSON を出力 |
| `--entry file` | lint | ルートの入口ページ(`<dir>` からの相対。既定は `index.md`、次に `README.md`、`root.md`) |
| `--max-lines N` | lint | 入口ページの行数上限(既定 200) |
| `--window N` | ugate | 根拠を探す上下の行数(既定 1) |
| `--include-code` | ugate | コードブロックも検査する |
| `--ignore prefix` | 両方 | パスの先頭が一致するものを除外(複数指定可)。例: `--ignore archive` |
| `-h`, `--help`, `--version` | | 使い方。`1.0.0` を表示 |

ディレクトリに対する `ugate` は、`.md`、`.markdown`、`.txt`、`.html`、`.htm` を検査します。ドット始まりのディレクトリは常に除外されます。

### 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 合格 |
| 1 | 指摘あり(ゲート失敗) |
| 2 | 引数不正、不明なサブコマンド、パスが存在しない、`lint` にファイルを渡した |

## JavaScript API

```js
import { lintWiki, scanUnverifiedClaims, scanPath } from 'cognitive-wiki-and-u-gate';

const wiki = lintWiki('./docs', { maxEntryLines: 200, ignore: ['archive'] });
const claims = scanUnverifiedClaims('Latency is about 40% lower.');
if (!claims.ok) for (const f of claims.findings) console.log(`${f.line}:${f.column} ${f.rule}`);
```

| エクスポート | 役割 |
| --- | --- |
| `lintWiki(dir, {maxEntryLines, entry, ignore})` | Wiki リンターの結果 |
| `scanUnverifiedClaims(textOrPath, {fromFile, window, includeCode, file})` | 1 つの文書を走査する。既定では入力をそのままテキストとして扱う。ファイルを読むには `{ fromFile: true }` を指定し、ファイルやディレクトリを走査するには `scanPath` を使う |
| `scanPath(fileOrDir, {window, includeCode, ignore})` | ファイルまたはディレクトリに対するゲート |

走査対象は各行の先頭 8,192 文字です。
| `renderLintText(result)` / `renderGateText(result)` | 人が読むレポート |
| `VERSION`, `DEFAULTS` | 定数 |

### 結果のスキーマ

```json
{ "ok": false, "dir": "docs", "entry": "index.md", "files": 3,
  "findings": [ { "rule": "broken_link", "severity": "error", "file": "index.md", "line": 3, "message": "..." } ],
  "counts": { "broken_link": 1 } }
```

```json
{ "ok": false, "input": "docs", "files": 3,
  "findings": [ { "rule": "unresolved_u", "severity": "error", "file": "ops/runbook.md", "line": 6, "column": 22, "text": "[U]", "message": "..." } ],
  "resolved": [ { "file": "a.md", "line": 2, "source": "vendor docs" } ],
  "counts": { "unresolved_u": 1 } }
```

指摘はファイル、次に行の順に並びます。`file` はスラッシュ区切りです。すべての指摘は error で、`ok` は指摘が 0 件のときだけ true です。

## 限界と注意点

- 統計と推定値のルールはヒューリスティックです。見ているのは「単位つきの数字」で、意味ではありません。誤検出(仕様書中の "100%"、出典そのものである料金表の価格など)も、見逃し(文字で書かれた数)もあります。その行に出典リンクか `[est]` を付ければ止まります。
- 根拠は形(リンクや `[source:` タグ)で判定します。出典が主張を裏付けているかどうかは確認せず、取得もしません。ネットワークには一切触れません。
- wiki リンクはディスク上のファイルとだけ照合します。アンカー(`#見出し`)と外部 URL は検証しません。
- 役割は、文字どおりの `role:` / `roles:` キーと `Role:` 見出しから読みます。ほかの書き方はリンターには見えません。
- Wiki リンターが「ページ」として扱うのは `.md` と `.markdown` だけです。シンボリックリンクのディレクトリはたどりません。
- 日本語は、推定値・件数のパターン(約、およそ、ほぼ、倍、割、万、人、社、件、円)とファイル名に対応しますが、一般的な主張の検出には対応していません。

## ファミリーでの位置づけ

- Tier 1(無料・MIT): 本パッケージ、`micro-02-retro-failure-linter`、`micro-04-shortlink-deliverable-portal`、Free Pack の `progressive-context-slicer`。
- Tier 2: 有料のマイクロパック。
- Tier 3: Master Edition「Autonomous HQ OS」。
- 公開コンパニオンリポジトリ: `agy-jev-harness`。

## ライセンス

MIT。`LICENSE` を参照してください。
