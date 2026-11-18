# retro-failure-linter

AI エージェントのセッションログ向けの振り返り(ポストモーテム)リンターです。JSONL か Markdown の記録を読み、繰り返される失敗をまとめ、5 つの失敗モードを正確な行番号つきで指摘します。さらに「2 回失敗したら止まって報告する」というエスカレーション規則を機械的に確認します。同じ失敗シグネチャが 3 回目に現れると、レポートは `escalate: true` になり、CLI は終了コード 1 を返します。

- 依存パッケージなし、Node 20 以上、MIT ライセンス。
- オフラインで決定的に動きます。同じログからは同じレポートが出ます。ネットワークもタイムスタンプも使いません。
- Jev Harness ファミリーの一部です(末尾参照)。

## 検査する内容

| モード | 意味 | 典型的な検出例 |
| --- | --- | --- |
| `repeat_failure` | 同じ失敗が繰り返されている | 正規化した同一エラーが 2 回以上。`--threshold` を超えると `escalate:true` |
| `unverified_claim` | 証拠なしの「完了・修正済み・全テスト通過」 | 直前 8 イベントに成功した実行結果がない主張(未解決の失敗が残っていれば high) |
| `guardrail_drift` | 保護策の回避 | `--no-verify`、`git push --force`、`rm -rf`、`--dangerously-*`、「テストをスキップ」など |
| `scope_creep` | 依頼範囲を超えた作業 | "while I'm at it"、"let me also"、「ついでに」「スコープ外」など |
| `tool_misuse` | ツールの誤用・同一呼び出しの連打 | "unknown option"、"missing required"、"command not found"、ENOENT、同じ呼び出しが 3 回連続 |

### エスカレーション規則

失敗の**シグネチャ**は、ツール名と「最初に失敗を示した行」を正規化したものです。数字、パス、ファイル名、ハッシュ、URL、日時は置き換えられるため、`Cannot find module ./gen-12.js` と `Cannot find module ./gen-97.js` は同じシグネチャになります。

しきい値が既定の 2 の場合:

- 同一シグネチャが 2 回: `repeat_failure`(medium)と `escalate_next: true`。次の試行は再実行ではなくエスカレーションが必要です。2 回目の失敗の後に、エスカレーションを示す発言(escalate、hand off、blocked、ask the user など)がすでにあれば、そのシグネチャは `acknowledged` となり指摘は出ません。
- 3 回以上: `escalate: true`。3 回目の失敗行を指す `repeat_failure`(high)と、人が読める `escalation_reason` を出力します。

## 30 秒クイックスタート

```bash
cd micro-02-retro-failure-linter
cat > session.jsonl <<'EOF'
{"role":"user","type":"message","text":"make the build pass"}
{"role":"tool","type":"tool_result","tool":"npm","status":"error","text":"Error: Cannot find module './gen-12.js'"}
{"role":"tool","type":"tool_result","tool":"npm","status":"error","text":"Error: Cannot find module './gen-97.js'"}
{"role":"tool","type":"tool_result","tool":"npm","status":"error","text":"Error: Cannot find module './gen-3.js'"}
{"role":"assistant","type":"message","text":"Fixed, the build is done."}
EOF
node bin/retro-lint.mjs session.jsonl                      # Markdown レポートを標準出力へ
node bin/retro-lint.mjs session.jsonl --format json --out report.json
echo $?                                                    # 1: 同一シグネチャの 3 回目の失敗と、証拠のない完了報告
```

レポートでは 4 行目が `npm|error: cannot find module ...` の 3 回目の失敗として示され、`escalate: true` となり、5 行目の "Fixed, done" は未解決の失敗の後の主張として指摘されます。

## 受け付けるログの形式

各行をまず JSON として解釈し、JSON オブジェクトとして読めない行は自由形式のテキストとして扱います。そのため JSONL、Markdown、両者が混在したファイルのいずれも使えます。CRLF 改行と UTF-8 BOM にも対応しています。指摘に出る行番号は入力ファイルの物理行(1 始まり)です。

JSONL のイベント(項目はすべて省略可):

```json
{"role":"assistant","type":"tool_call","tool":"bash","input":{"command":"npm test"}}
{"role":"tool","type":"tool_result","tool":"bash","status":"error","exit_code":1,"text":"Error: ..."}
{"role":"assistant","type":"message","text":"All tests pass."}
```

| 項目 | 用途 |
| --- | --- |
| `role` | `user`、`assistant`、`system`、`tool`(別名: human、ai、claude、function)。user と system の行は指摘対象外 |
| `type` | `tool_call`、`tool_result`、`message`、`error` |
| `tool`(`tool_name`、`name`) | 失敗シグネチャの一部 |
| `status` | `error`、`failed`、`timeout`、`denied` は失敗、`ok`、`success`、`passed` は証拠 |
| `exit_code`(`exitCode`) | 0 以外は失敗、0 は証拠 |
| `text`(`content`、`message`、`error`、`output`、`stderr`、`result`) | 本文。`content` は文字列、または `{text}` の配列 |
| `input`(`args`、`arguments`、`params`) | 保護策回避フラグの検出と、同一呼び出しの連打検出に使用 |

Markdown・自由形式の行:

```text
**User:** fix the build
Assistant: running the tests
Tool: npm test
Error: Cannot find module ./gen-12.js
- exit code 2
Assistant: Done, fixed.
```

`User:`、`**Assistant:**`、`## Tool`、`Claude:` のような役割マーカーが、以降の行の役割を決めます。`Tool: 名前` や `` Ran `コマンド` `` の行は、以降の行のツール名になります。失敗と見なすのは、`Error:`、`Traceback`、`FAIL`、`exit code N`(0 以外)、`command not found`、`permission denied`、`ENOENT`、行頭の `error` / `fatal`、失敗マーク、そしてアシスタントの地の文以外での "failed" / "timed out" です。

## CLI リファレンス

```text
retro-lint <logfile> [--format json|md] [--threshold 2] [--out file]
```

| オプション | 既定値 | 意味 |
| --- | --- | --- |
| `--format json\|md` | `md` | レポート形式。`--json` は `--format json` の別名 |
| `--threshold N` | `2` | 次の試行でエスカレーションが必要になるまでに許容する同一シグネチャの失敗回数 |
| `--out file` | 標準出力 | レポートを一時ファイル+リネームで安全に書き出し、1 行の要約を表示 |
| `-h`, `--help` | | 使い方 |
| `--version` | | `1.0.0` を表示 |

### 終了コード

| コード | 意味 |
| --- | --- |
| 0 | エスカレーション不要で、high の指摘もない |
| 1 | `escalate:true`、または high の指摘が 1 件以上 |
| 2 | 引数が不正、またはファイルがない・読めない |

## JavaScript API

```js
import { lintFile, lintLog, renderMarkdown, renderJson, normaliseSignature } from 'retro-failure-linter';

const report = lintFile('session.jsonl', { threshold: 2 });
if (report.escalate) console.error(report.escalation_reason);
console.log(renderMarkdown(report));
```

| エクスポート | 役割 |
| --- | --- |
| `lintLog(text, {threshold, source})` | 文字列を検査してレポートを返す。しきい値が 1 未満なら `RangeError` |
| `lintFile(path, opts)` | UTF-8 ファイルを読んで検査する |
| `parseLog(text)` | `{events, warnings, jsonLines, textLines}` を返す |
| `normaliseSignature(text)` | クラスタリングに使う正規化関数 |
| `renderMarkdown(report)` / `renderJson(report)` | レポート本文を返す |
| `writeFileAtomic(file, data)` | 一時ファイル+リネームで書き込む |
| `VERSION`, `FAILURE_MODES`, `DEFAULT_THRESHOLD` | 定数 |

### レポートのスキーマ

```json
{
  "tool": "retro-lint", "version": "1.0.0", "source": "session.jsonl",
  "threshold": 2, "format": "jsonl|markdown|mixed",
  "events": 8, "failures": 3,
  "escalate": true, "escalate_next": false, "escalation_reason": "signature ... failed 3 times (lines 3, 5, 7); ...",
  "ok": false,
  "summary": { "by_mode": { "repeat_failure": 1, "...": 0 }, "by_severity": { "high": 3, "medium": 0, "low": 0 } },
  "signatures": [ { "signature": "npm|error: ...", "tool": "npm", "count": 3, "lines": [3,5,7], "acknowledged": false } ],
  "findings": [ { "id": "F001", "mode": "guardrail_drift", "severity": "high", "line": 6,
                  "message": "...", "evidence": "...", "recommendation": "..." } ],
  "warnings": []
}
```

指摘は行番号、次いでモードの順に並びます。`ok` は、エスカレーションがなく high の指摘もないときに true です。

## 限界と注意点

- これはパターンに基づくリンターで、判定者ではありません。珍しい言い回しの失敗は見逃すことがあり、無害な文を指摘することもあります。指摘は「見直しのきっかけ」として扱ってください。
- パターンは英語と、ごく一部の日本語表現が対象です。それ以外の言語は検出しません。
- `unverified_claim` は直前 8 イベントの範囲で成功した実行結果を探します。それより前にある証拠や、地の文だけの証拠は見えません。同じ行に `(verified: npm test exit 0)` のように根拠を書いてください。
- `guardrail_drift` と `scope_creep` は user と system の行を飛ばし、直前に "never"、"do not"、"avoid" などがある一致は無視します。否定の扱いは単純です。
- Markdown の役割判定は行単位です。役割マーカーのない記録は、話者不明の 1 人として扱われます。
- 処理負荷の高いパターンは、各行の先頭 4,096 文字まで照合します。
- シグネチャのまとめ方は意図的に粗くしてあります。数字やパスだけが違う別々のエラーは 1 つとして数えられます。
- エスカレーション規則は事後にログから違反を報告するもので、動作中のエージェントを止めることはできません。

## ファミリーでの位置づけ

- Tier 1(無料・MIT): 本パッケージ、`micro-03-cognitive-wiki-and-u-gate`、`micro-04-shortlink-deliverable-portal`、Free Pack の `progressive-context-slicer`。
- Tier 2: 有料のマイクロパック。
- Tier 3: Master Edition「Autonomous HQ OS」。
- 公開コンパニオンリポジトリ: `agy-jev-harness`。

## ライセンス

MIT。`LICENSE` を参照してください。
