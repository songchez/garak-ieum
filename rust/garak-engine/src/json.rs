//! A small JSON reader for the protocol messages (RFC 8259; control thread only).
//!
//! No serde: the protocol is a handful of shapes read field by field (protocol.rs mirrors
//! native/src/protocol.hpp line for line), and a dependency-free DOM keeps the WASM module small.
//! Numbers go through `core`'s correctly rounded `f64` parser, so every value is the double
//! nlohmann::json produces for the same text. Duplicate object keys: the last one wins (nlohmann).

use alloc::string::String;
use alloc::vec::Vec;

use crate::error::Error;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// `integer` is true when the literal had no fraction or exponent (nlohmann's integer kinds).
    Number {
        value: f64,
        integer: bool,
    },
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

const MAX_DEPTH: usize = 64;

impl Json {
    pub fn parse(text: &[u8]) -> Result<Json, Error> {
        let mut p = Parser { s: text, i: 0 };
        p.ws();
        let v = p.value(0)?;
        p.ws();
        if p.i != text.len() {
            return Err(Error::new("Trailing characters after JSON value"));
        }
        Ok(v)
    }

    /// Member `key` of an object (the last one with that name), or None.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(members) => members.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number { value, .. } => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(o) => Some(o),
            _ => None,
        }
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn bump(&mut self) -> Option<u8> {
        let c = self.peek()?;
        self.i += 1;
        Some(c)
    }

    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn literal(&mut self, word: &[u8], value: Json) -> Result<Json, Error> {
        if self.s.get(self.i..self.i + word.len()) == Some(word) {
            self.i += word.len();
            Ok(value)
        } else {
            Err(Error::new("Invalid JSON literal"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Json, Error> {
        if depth > MAX_DEPTH {
            return Err(Error::new("JSON nesting too deep"));
        }
        match self.peek() {
            Some(b'n') => self.literal(b"null", Json::Null),
            Some(b't') => self.literal(b"true", Json::Bool(true)),
            Some(b'f') => self.literal(b"false", Json::Bool(false)),
            Some(b'"') => Ok(Json::String(self.string()?)),
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.i += 1;
                    return Ok(Json::Array(items));
                }
                loop {
                    self.ws();
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.bump() {
                        Some(b',') => continue,
                        Some(b']') => return Ok(Json::Array(items)),
                        _ => return Err(Error::new("Expected , or ] in JSON array")),
                    }
                }
            }
            Some(b'{') => {
                self.i += 1;
                let mut members = Vec::new();
                self.ws();
                if self.peek() == Some(b'}') {
                    self.i += 1;
                    return Ok(Json::Object(members));
                }
                loop {
                    self.ws();
                    if self.peek() != Some(b'"') {
                        return Err(Error::new("Expected a JSON object key"));
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.bump() != Some(b':') {
                        return Err(Error::new("Expected : in JSON object"));
                    }
                    self.ws();
                    let value = self.value(depth + 1)?;
                    members.push((key, value));
                    self.ws();
                    match self.bump() {
                        Some(b',') => continue,
                        Some(b'}') => return Ok(Json::Object(members)),
                        _ => return Err(Error::new("Expected , or } in JSON object")),
                    }
                }
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(Error::new("Invalid JSON value")),
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.i;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.i += 1;
        }
        self.i - start
    }

    fn number(&mut self) -> Result<Json, Error> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        let first = self.peek();
        let whole = self.digits();
        if whole == 0 || (first == Some(b'0') && whole > 1) {
            return Err(Error::new("Invalid JSON number"));
        }
        let mut integer = true;
        if self.peek() == Some(b'.') {
            self.i += 1;
            integer = false;
            if self.digits() == 0 {
                return Err(Error::new("Invalid JSON number"));
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            integer = false;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if self.digits() == 0 {
                return Err(Error::new("Invalid JSON number"));
            }
        }
        let text = self.s.get(start..self.i).and_then(|b| core::str::from_utf8(b).ok());
        let value =
            text.and_then(|t| t.parse::<f64>().ok()).ok_or_else(|| Error::new("Invalid JSON number"))?;
        Ok(Json::Number { value, integer })
    }

    fn hex4(&mut self) -> Result<u32, Error> {
        let mut v = 0u32;
        for _ in 0..4 {
            let c = self.bump().ok_or_else(|| Error::new("Truncated JSON escape"))?;
            let d = (c as char).to_digit(16).ok_or_else(|| Error::new("Invalid JSON escape"))?;
            v = v * 16 + d;
        }
        Ok(v)
    }

    fn string(&mut self) -> Result<String, Error> {
        self.i += 1; // opening quote
        let mut out: Vec<u8> = Vec::new();
        loop {
            let c = self.bump().ok_or_else(|| Error::new("Unterminated JSON string"))?;
            match c {
                b'"' => break,
                b'\\' => {
                    let e = self.bump().ok_or_else(|| Error::new("Unterminated JSON string"))?;
                    let ch = match e {
                        b'"' => '"',
                        b'\\' => '\\',
                        b'/' => '/',
                        b'b' => '\u{8}',
                        b'f' => '\u{c}',
                        b'n' => '\n',
                        b'r' => '\r',
                        b't' => '\t',
                        b'u' => {
                            let hi = self.hex4()?;
                            let code = if (0xD800..0xDC00).contains(&hi) {
                                if self.bump() != Some(b'\\') || self.bump() != Some(b'u') {
                                    return Err(Error::new("Unpaired JSON surrogate"));
                                }
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(Error::new("Unpaired JSON surrogate"));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                hi
                            };
                            char::from_u32(code).ok_or_else(|| Error::new("Invalid JSON escape"))?
                        }
                        _ => return Err(Error::new("Invalid JSON escape")),
                    };
                    let mut buf = [0u8; 4];
                    out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                }
                0..=0x1F => return Err(Error::new("Control character in JSON string")),
                _ => out.push(c),
            }
        }
        String::from_utf8(out).map_err(|_| Error::new("Invalid UTF-8 in JSON string"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_protocol_shapes() {
        let v =
            Json::parse(br#" {"a": [1, -2.5e3, true, null], "b": {"c": "x\u00e9\ud83c\udfb5"}, "a": 7} "#)
                .unwrap();
        assert_eq!(v.get("a").and_then(Json::as_f64), Some(7.0)); // last duplicate wins
        assert_eq!(v.get("b").and_then(|b| b.get("c")).and_then(Json::as_str), Some("xé🎵"));
        let n = Json::parse(b"0.1").unwrap();
        assert_eq!(n, Json::Number { value: 0.1, integer: false });
        assert!(matches!(Json::parse(b"12").unwrap(), Json::Number { integer: true, .. }));
        for bad in [&b"01"[..], b"[1,]", b"{\"a\"}", b"\"\\x\"", b"1 2", b"-", b"1.", b"[", b"\"\x01\""] {
            assert!(Json::parse(bad).is_err(), "{:?}", core::str::from_utf8(bad));
        }
    }

    #[test]
    fn deep_nesting_is_refused_without_overflow() {
        let mut s = std::vec![b'['; 10_000];
        s.extend(std::vec![b']'; 10_000]);
        assert!(Json::parse(&s).is_err());
    }
}
