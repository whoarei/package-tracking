use crate::model::{Data, QueryState};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
};

pub struct Storage {
    path: PathBuf,
}
impl Storage {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("shipments.json"),
        }
    }
    pub fn load(&self) -> Result<Data, String> {
        if !self.path.exists() {
            return Ok(Data::default());
        }
        let bytes = fs::read(&self.path).map_err(|e| format!("读取本地数据失败：{e}"))?;
        let mut data: Data = serde_json::from_slice(&bytes)
            .map_err(|e| format!("本地数据文件无法解析，原文件已保留，请先备份：{e}"))?;
        if data.version != 1 {
            return Err("本地数据版本不受支持，请使用匹配版本的运单工作台".into());
        }
        data.settings.validate()?;
        for s in &mut data.shipments {
            if s.query_state == QueryState::Querying {
                s.query_state = QueryState::Error;
                s.error = Some("上次查询中断，可以重新查询".into());
            }
        }
        Ok(data)
    }
    pub fn save(&self, data: &Data) -> Result<(), String> {
        let dir = self.path.parent().ok_or("无效的数据目录")?;
        fs::create_dir_all(dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
        let temp = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        let mut file = File::create(&temp).map_err(|e| format!("无法写入本地数据：{e}"))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("保存数据失败：{e}"))?;
        drop(file);
        fs::rename(&temp, &self.path)
            .map_err(|e| format!("替换数据文件失败，原文件已保留：{e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ImportRow, Shipment};
    #[test]
    fn persisted_history_survives_restart_and_interrupted_jobs_reset() {
        let dir = tempfile::tempdir().unwrap();
        let store = Storage::new(dir.path());
        let mut data = Data::default();
        let mut shipment = Shipment::from_row(ImportRow {
            number: "001234567890".into(),
            carrier: "".into(),
            note: "测试".into(),
        });
        shipment.query_state = QueryState::Querying;
        data.shipments.push(shipment);
        store.save(&data).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.shipments[0].number, "001234567890");
        assert_eq!(loaded.shipments[0].query_state, QueryState::Error);
        data.shipments[0].note = "更新".into();
        store.save(&data).unwrap();
        assert_eq!(store.load().unwrap().shipments[0].note, "更新");
    }
    #[test]
    fn corrupt_data_is_not_silently_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("shipments.json"), b"broken").unwrap();
        assert!(Storage::new(dir.path()).load().is_err());
        assert_eq!(
            fs::read(dir.path().join("shipments.json")).unwrap(),
            b"broken"
        );
    }
}
