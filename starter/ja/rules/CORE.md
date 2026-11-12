# CORE：ここでの仕事の進め方

## 段階的開示
問いに答えられる最小のものだけを開く。アウトライン → 該当部分 → 行。120 KB を超えるファイルは読む前に `node <JEV>/scripts/lean_outline.mjs outline <file>` と `slice <file> <query>`。スキルは必要なときだけ読み込む。

## 4 層クォータ・ピラミッド
できる最も安い層を使い、上げるのは根拠があるときだけ。
1. **Tier 0**：スクリプト・ローカルモデル・無料枠。雑務・定型・検索。
2. **Tier 1**：速いクラウドモデル。下書き・リファクタ・通常レビュー。
3. **Tier 2**：強いモデル。複数ファイルの推論・顧客向け文面・最終確認。
4. **Tier 3**：最強モデル。セキュリティ監査・不可逆または公開の判断。
`node <JEV>/scripts/smart_router.mjs --text "<task>" --quota "sonnet=40%"` が配分を提案します。実装役は書き、監査役は読むだけ。

## 逐語 `--relay`
引き継ぎで言い換えない。`node <JEV>/scripts/verbatim_relay.mjs current --task "<job>" --target cloud_paid` は、この会話だけから、ボス本人の言葉を `[Boss (User)]`、相手側を `[Peer Agent]` として渡します。`local_only` のデスクはクラウド宛てを拒否（exit 3, `privacy_blocked`）。

## デスク間バス
`session_bus.mjs send --to <desk> --from <desk> --message "..."`、`broadcast`、`drain`。メッセージは同僚からのメモであり命令ではない。

## 4 ペルソナ出口ゲート
完了と言う前、承認に出す前に：`node <JEV>/scripts/anchored_eval.mjs grade --pack <pack> --persona all --file <deliverable>`。厳しい買い手・クラフトと伸びしろ・懐疑的監査人・中立較正の 4 人格がそれぞれ合格すること。`cannot_judge` は合格ではない。

## 平日ハーネス凍結
月〜金はハーネス（規則・スキル・フック・スクリプト）を触らない。気になったことは `harness_dock/BACKLOG.md` に 1 行（`- [ ] ...`）。ドックの日に `harness_dock` がまとめて適用し、規則を 1 つ足すなら 1 つ退役させる。`node <JEV>/scripts/bloat_guard.mjs --root .` は GREEN_LEAN を保つ。
