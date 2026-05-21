## 1. 内容

工具链幻觉,pev block 内插入了乱码字节,既无法 JSON.parse 也无法被 lenient parser 还原。

```pev
{
  "schema_version": "1.0",
  "agent_id": "static_analyst",
  "round": 0,
  ##!@@@%%^^&&** garbled bytes here **&&^^%%@@@!##
  "observations": [],
  "hypothesis_updates": [],
  "next_action": { "kind": "observe_only", "rationale": "x" }
}
```

```cav
{ "self_entropy": 0.4, "calibration": null, "update_kl": null, "repair_style": "none" }
```
