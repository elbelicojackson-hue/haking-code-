## 1. 内容

模型完全忘了写 schema_version(常见错误)。其他字段合规。

```pev
{
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
  "next_action": {
    "kind": "observe_only",
    "rationale": "let other agents register their slices"
  }
}
```

```cav
{ "self_entropy": 0.05, "calibration": null, "update_kl": null, "repair_style": "none" }
```
