## 1. 内容

模型用 JS 习惯往 JSON 里塞注释 — 既有 `//` 行注释,也有 `/* ... */` 块注释。Layer-2 的 textual cleanup 应当把它们剥掉。

```pev
{
  // schema version pin
  "schema_version": "1.0",
  "agent_id": "static_analyst",
  "round": 0,
  /* 本轮无 observation */
  "observations": [],
  "hypothesis_updates": [
    {
      "op": "create",
      "id": "H1",
      "kind": "capability",
      "text": "Imports table includes CryptAcquireContextW and HttpSendRequestW.",
      "confidence": 0.7 // confidence based on import names alone
    }
  ],
  "next_action": {
    "kind": "observe_only",
    "rationale": "queue capability::imports-table for dispatch"
  }
}
```

```cav
{ "self_entropy": 0.2, "calibration": null, "update_kl": null, "repair_style": "none" }
```
