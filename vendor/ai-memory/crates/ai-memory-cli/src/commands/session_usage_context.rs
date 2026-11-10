//! Bounded transcript coordinates. Tool payloads never enter this state.
//!
//! Claude tool ids pair `tool_use` with `tool_result`:
//! https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
//! Codex turn/response coordinates are explicit protocol fields:
//! https://github.com/openai/codex/blob/main/codex-rs/core/src/state/session.rs
//! https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn_context.rs
//! A Codex tool in the same turn is an association, never an inferred cause.

use ai_memory_core::{AgentKind, TokenCall, TokenCallContext, TokenToolRef, TokenToolRelation};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct ScanContext {
    turn: Option<String>,
    known: Vec<TokenToolRef>,
    input_parent: Option<String>,
    inputs: Vec<TokenToolRef>,
    last: Option<TokenCall>,
}

fn id(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
        })
        .map(str::to_owned)
}

fn add(to: &mut Vec<TokenToolRef>, tool: TokenToolRef) {
    if let Some(old) = to
        .iter_mut()
        .find(|t| t.id == tool.id && t.relation == tool.relation)
    {
        old.is_error = match (old.is_error, tool.is_error) {
            (Some(true), _) | (_, Some(true)) => Some(true),
            (_, v) => v.or(old.is_error),
        };
    } else if to.len() < 16 {
        to.push(tool);
    }
}

impl ScanContext {
    fn set_turn(&mut self, turn: Option<String>) {
        if self.turn != turn {
            self.known.clear();
            self.inputs.clear();
            self.input_parent = None;
            self.last = None;
        }
        self.turn = turn;
    }

    pub(super) fn observe(&mut self, v: &Value, agent: AgentKind) -> Option<TokenCall> {
        let mut changed = false;
        if agent == AgentKind::ClaudeCode {
            if v["type"] == "user" && v["isMeta"] != true {
                let results = v
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .map(|c| {
                        c.iter()
                            .filter(|b| b["type"] == "tool_result")
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if results.is_empty() {
                    self.set_turn(id(v.get("uuid")));
                } else {
                    self.input_parent = id(v.get("uuid"));
                    self.inputs.clear();
                    for result in results {
                        let Some(tool_id) = id(result.get("tool_use_id")) else {
                            continue;
                        };
                        if let Some(tool) = self.known.iter_mut().find(|t| t.id == tool_id) {
                            tool.is_error = result.get("is_error").and_then(Value::as_bool);
                            let mut input = tool.clone();
                            input.relation = TokenToolRelation::Input;
                            add(&mut self.inputs, input);
                            changed = true;
                        }
                    }
                }
            }
            if v["type"] == "assistant"
                && let Some(content) = v.pointer("/message/content").and_then(Value::as_array)
            {
                for block in content.iter().filter(|b| b["type"] == "tool_use") {
                    if let (Some(id), Some(name)) = (
                        id(block.get("id")),
                        block
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|n| n.len() <= 128),
                    ) {
                        add(
                            &mut self.known,
                            TokenToolRef {
                                id,
                                name: name.into(),
                                relation: TokenToolRelation::Requested,
                                is_error: None,
                            },
                        );
                    }
                }
            }
        } else {
            if v["type"] == "turn_context" {
                self.set_turn(id(v.pointer("/payload/turn_id")));
            }
            if let Some(turn) = id(v.pointer("/payload/turn_id")) {
                self.set_turn(Some(turn));
            }
            if v["type"] == "response_item"
                && matches!(
                    v.pointer("/payload/type").and_then(Value::as_str),
                    Some("function_call" | "custom_tool_call")
                )
                && self.turn.is_some()
                && let (Some(id), Some(name)) = (
                    id(v.pointer("/payload/call_id")),
                    v.pointer("/payload/name")
                        .and_then(Value::as_str)
                        .filter(|n| n.len() <= 128),
                )
            {
                add(
                    &mut self.known,
                    TokenToolRef {
                        id,
                        name: name.into(),
                        relation: TokenToolRelation::Turn,
                        is_error: None,
                    },
                );
                changed = true;
            }
        }
        if !changed {
            return None;
        }
        let mut last = self.last.clone()?;
        let context = last.context.as_mut()?;
        if self.turn.is_none() || context.turn_id != self.turn {
            return None;
        }
        if agent == AgentKind::ClaudeCode {
            for tool in &mut context.tools {
                if let Some(known) = self.known.iter().find(|k| k.id == tool.id) {
                    tool.is_error = known.is_error.or(tool.is_error);
                }
            }
        } else {
            for tool in &self.known {
                add(&mut context.tools, tool.clone());
            }
        }
        self.last = Some(last.clone());
        Some(last)
    }

    pub(super) fn for_call(&self, v: &Value, agent: AgentKind) -> TokenCallContext {
        let mut tools = Vec::new();
        if agent == AgentKind::ClaudeCode {
            if self.input_parent.is_some() && id(v.get("parentUuid")) == self.input_parent {
                for tool in &self.inputs {
                    add(&mut tools, tool.clone());
                }
            }
            if let Some(content) = v.pointer("/message/content").and_then(Value::as_array) {
                for block in content.iter().filter(|b| b["type"] == "tool_use") {
                    if let Some(id) = id(block.get("id"))
                        && let Some(tool) = self.known.iter().find(|t| t.id == id)
                    {
                        add(&mut tools, tool.clone());
                    }
                }
            }
        } else if self.turn.is_some() {
            tools = self.known.clone();
        }
        TokenCallContext {
            turn_id: self.turn.clone(),
            response_id: id(if agent == AgentKind::ClaudeCode {
                v.pointer("/message/id")
            } else {
                v.pointer("/payload/response_id")
            }),
            recorded_at: v
                .get("timestamp")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 64)
                .and_then(|s| s.parse::<jiff::Timestamp>().ok())
                .map(|t| t.to_string()),
            tools,
        }
    }

    pub(super) fn remember(&mut self, call: &TokenCall) {
        self.last = Some(call.clone());
    }
}

pub(super) fn merge_context(old: &mut TokenCall, new: &TokenCall) {
    if let Some(next) = &new.context {
        if let Some(context) = old.context.as_mut() {
            if context.turn_id.is_none() {
                context.turn_id = next.turn_id.clone();
            }
            if context.response_id.is_none() {
                context.response_id = next.response_id.clone();
            }
            if context.recorded_at.is_none() {
                context.recorded_at = next.recorded_at.clone();
            }
            for tool in &next.tools {
                add(&mut context.tools, tool.clone());
            }
        } else {
            old.context = Some(next.clone());
        }
    }
}
