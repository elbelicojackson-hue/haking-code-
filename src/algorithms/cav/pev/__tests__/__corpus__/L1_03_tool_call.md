## 1. 内容

H1 是 evidence,但需要再用 `packer::upx-test` 自检确认壳完整性。本轮分配 tool_call。

```pev
{
  "schema_version": "1.0",
  "agent_id": "static_analyst",
  "round": 0,
  "observations": [],
  "hypothesis_updates": [],
  "next_action": {
    "kind": "tool_call",
    "hypothesis_id": "H1",
    "tool_plan_id": "packer::upx-test",
    "args_override": null
  }
}
```

```cav
{ "self_entropy": 0.05, "calibration": null, "update_kl": 0.1, "repair_style": "none" }
```
