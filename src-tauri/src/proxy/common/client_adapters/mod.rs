// Client Adapters 模块
// 存放各种客户端的适配器实现

pub mod opencode;
pub mod codex;

pub use opencode::OpencodeAdapter;
pub use codex::CodexAdapter;
