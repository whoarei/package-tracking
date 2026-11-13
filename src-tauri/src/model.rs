use chrono::Utc;
use serde::{Deserialize, Serialize};

pub fn now() -> String {
    Utc::now().to_rfc3339()
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShipmentStatus {
    #[default]
    Pending,
    InTransit,
    OutForDelivery,
    Delivered,
    Exception,
    Returned,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QueryState {
    #[default]
    Pending,
    Querying,
    Success,
    Error,
    Attention,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TrackingEvent {
    pub time: String,
    pub context: String,
    #[serde(default)]
    pub location: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shipment {
    pub id: String,
    pub number: String,
    pub carrier: String,
    pub carrier_name: String,
    pub note: String,
    pub status: ShipmentStatus,
    pub query_state: QueryState,
    pub events: Vec<TrackingEvent>,
    pub tracking: bool,
    pub created_at: String,
    pub checked_at: Option<String>,
    pub error: Option<String>,
}
impl Shipment {
    pub fn from_row(row: ImportRow) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            number: row.number,
            carrier: row.carrier,
            carrier_name: String::new(),
            note: row.note,
            status: ShipmentStatus::Pending,
            query_state: QueryState::Pending,
            events: vec![],
            tracking: true,
            created_at: now(),
            checked_at: None,
            error: None,
        }
    }
    pub fn due(&self, settings: &Settings, at: chrono::DateTime<Utc>) -> bool {
        if !self.tracking
            || matches!(
                self.status,
                ShipmentStatus::Delivered | ShipmentStatus::Returned
            )
            || self.query_state == QueryState::Attention
        {
            return false;
        }
        self.checked_at
            .as_ref()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|last| {
                at.signed_duration_since(last).num_minutes() >= settings.interval_minutes as i64
            })
            .unwrap_or(true)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub auto_track: bool,
    pub interval_minutes: u32,
    pub request_delay_seconds: u32,
    pub browser_path: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_track: false,
            interval_minutes: 60,
            request_delay_seconds: 5,
            browser_path: String::new(),
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !(5..=1440).contains(&self.interval_minutes) {
            return Err("复查间隔应在 5–1440 分钟之间".into());
        }
        if !(2..=120).contains(&self.request_delay_seconds) {
            return Err("查询间隔应在 2–120 秒之间".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Data {
    pub version: u32,
    pub shipments: Vec<Shipment>,
    pub settings: Settings,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            version: 1,
            shipments: vec![],
            settings: Settings::default(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    #[default]
    Idle,
    Running,
    Paused,
    Waiting,
    Cancelling,
    Completed,
    Cancelled,
    Failed,
}
impl Phase {
    pub fn active(&self) -> bool {
        matches!(
            self,
            Self::Running | Self::Paused | Self::Waiting | Self::Cancelling
        )
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub phase: Phase,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub skipped: usize,
    pub current_id: Option<String>,
    pub current_number: Option<String>,
    pub message: String,
    pub started_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub shipments: Vec<Shipment>,
    pub settings: Settings,
    pub job: Job,
    pub data_dir: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ImportRow {
    pub number: String,
    #[serde(default)]
    pub carrier: String,
    #[serde(default)]
    pub note: String,
}
impl ImportRow {
    pub fn normalize(mut self) -> Option<Self> {
        self.number = self.number.trim().to_ascii_uppercase();
        self.carrier = self.carrier.trim().to_ascii_lowercase();
        if !(6..=40).contains(&self.number.len())
            || !self
                .number
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            || self.carrier.len() > 50
            || !self
                .carrier
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
        {
            return None;
        }
        self.note = self.note.chars().take(200).collect();
        Some(self)
    }
}
#[derive(Default, Debug, Serialize)]
pub struct ImportResult {
    pub added: usize,
    pub duplicates: usize,
    pub invalid: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub carrier: String,
    #[serde(default)]
    pub carrier_name: String,
    pub state: String,
    pub events: Vec<TrackingEvent>,
}
impl QueryResult {
    pub fn status(&self) -> ShipmentStatus {
        // Kuaidi100 state codes; query failures never become logistics exceptions.
        match self.state.as_str() {
            "3" => ShipmentStatus::Delivered,
            "5" | "6" => ShipmentStatus::Returned,
            "4" => ShipmentStatus::OutForDelivery,
            "2" | "14" => ShipmentStatus::Exception,
            "0" | "1" | "7" | "8" | "10" | "11" | "12" | "13" => ShipmentStatus::InTransit,
            _ => {
                let latest = self
                    .events
                    .first()
                    .map(|e| e.context.as_str())
                    .unwrap_or("");
                if latest.contains("已签收") || latest.contains("签收人") {
                    ShipmentStatus::Delivered
                } else if latest.contains("派送") || latest.contains("配送中") {
                    ShipmentStatus::OutForDelivery
                } else if latest.contains("退回") || latest.contains("退签") {
                    ShipmentStatus::Returned
                } else if latest.contains("异常") || latest.contains("拒收") {
                    ShipmentStatus::Exception
                } else if self.events.is_empty() {
                    ShipmentStatus::Pending
                } else {
                    ShipmentStatus::InTransit
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn leading_zeroes_and_long_numbers_are_preserved() {
        let row = ImportRow {
            number: " 0012345678901234567890 ".into(),
            carrier: "".into(),
            note: "".into(),
        }
        .normalize()
        .unwrap();
        assert_eq!(row.number, "0012345678901234567890");
    }
    #[test]
    fn malformed_numbers_cannot_enter_a_browser_expression() {
        assert!(ImportRow {
            number: "123456');alert(1)//".into(),
            carrier: "".into(),
            note: "".into()
        }
        .normalize()
        .is_none());
    }
    #[test]
    fn signed_and_attention_shipments_are_not_scheduled() {
        let mut s = Shipment::from_row(ImportRow {
            number: "SF12345678".into(),
            carrier: "".into(),
            note: "".into(),
        });
        assert!(s.due(&Settings::default(), Utc::now()));
        s.status = ShipmentStatus::Delivered;
        assert!(!s.due(&Settings::default(), Utc::now()));
        s.status = ShipmentStatus::InTransit;
        s.query_state = QueryState::Attention;
        assert!(!s.due(&Settings::default(), Utc::now()));
    }
    #[test]
    fn state_code_takes_precedence_over_free_text() {
        let result = QueryResult {
            carrier: "".into(),
            carrier_name: "".into(),
            state: "0".into(),
            events: vec![TrackingEvent {
                time: "".into(),
                context: "尚未签收，正在运输".into(),
                location: "".into(),
            }],
        };
        assert_eq!(result.status(), ShipmentStatus::InTransit);
    }
}
