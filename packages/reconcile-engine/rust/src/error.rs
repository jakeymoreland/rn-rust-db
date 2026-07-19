use std::fmt;

#[derive(Debug, Clone)]
pub enum EngineError {
    Parse(String),
    Storage(String),
    Source(String),
    Command(String),
}

impl EngineError {
    pub fn code(&self) -> u32 {
        match self {
            EngineError::Parse(_) => 1,
            EngineError::Storage(_) => 2,
            EngineError::Source(_) => 3,
            EngineError::Command(_) => 4,
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EngineError::Parse(m) => write!(f, "parse error: {m}"),
            EngineError::Storage(m) => write!(f, "storage error: {m}"),
            EngineError::Source(m) => write!(f, "source error: {m}"),
            EngineError::Command(m) => write!(f, "command error: {m}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<rusqlite::Error> for EngineError {
    fn from(e: rusqlite::Error) -> Self {
        EngineError::Storage(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable() {
        assert_eq!(EngineError::Parse("x".into()).code(), 1);
        assert_eq!(EngineError::Storage("x".into()).code(), 2);
        assert_eq!(EngineError::Source("x".into()).code(), 3);
        assert_eq!(EngineError::Command("x".into()).code(), 4);
    }

    #[test]
    fn display_includes_message() {
        assert_eq!(
            EngineError::Command("nope".into()).to_string(),
            "command error: nope"
        );
    }
}
