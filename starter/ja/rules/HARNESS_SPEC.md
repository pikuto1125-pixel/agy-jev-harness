# HARNESS_SPEC（ハーネスを変えるときだけ開く）

## 圧縮優先のデスク
- 1 デスク ＝ 1 つの長寿命の会話 ＝ 1 つの仕事。新しいスレッドに置き換えない。
- コンテキストが満杯になるとプラットフォームが圧縮する。直後にデスクは `Tasks/handover_now.md` と自分の役割ファイルを読み直し、ニュアンス救出がボスの制約を再注入する。
- 長い作業の区切りの前に、デスクは `handover_now.md` の自分の節（焦点・未完のスレッド・ボスの制約の逐語・次の 3 手）を書き直す。

## ファイル
- `Tasks/sessions_keep.json`：デスク、紐づいた会話 ID、プライバシー（`cloud_ok` | `local_only`）、`dockDay`。
- `Tasks/decisions_open.md`：ボスにしか答えられない問い。1 行ずつ。coordinator が聞き、ボスが答える。
- `Tasks/_bus/`：デスク間メッセージ（実行時の状態。git 管理外）。
- `harness_dock/BACKLOG.md`、`harness_dock/WEEKLY_DIGEST.md`：週次ループ（`dock_feeder.mjs digest`）。
- `_backups/`：上書き・削除の前に原本をここへ複製。

## 終了コード
`0` 成功、`1` 失敗、`2` 使い方、`3` 判定不能／プライバシー遮断、`4` ロック中（音声確認）。

## ハーネスを変えるとき
ドックの日だけ。規則は 1 つ退役させてから 1 つ足す。`bloat_guard.mjs` と触ったスクリプトのテストを再実行し、意図ではなく実際に見た結果を報告する。
