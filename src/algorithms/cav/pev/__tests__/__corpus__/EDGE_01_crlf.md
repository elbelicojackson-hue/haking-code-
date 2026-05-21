## 1. 内容

模型在 Windows 控制台输出,line endings 是 CRLF。
(parser.test.ts 在读取本文件后会显式把 LF 转成 CRLF,以验证 fenced-block extractor 对 CRLF 的容忍。)

```pev
{
  "schema_version": "1.0",
  "agent_id": "static_analyst",
  "round": 0,
  "observations": [],
  "hypothesis_updates": [
    {
      "op": "create",
      "id": "H1",
      "kind": "file-class",
      "text": "PE32+ executable, 64-bit Windows binary.",
      "confidence": 0.95
    }
  ],
  "next_action": { "kind": "observe_only", "rationale": "next round dispatch" }
}
```

```cav
{ "self_entropy": 0.05, "calibration": null, "update_kl": null, "repair_style": "none" }
```
