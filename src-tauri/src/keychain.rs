use keyring::Entry;

#[tauri::command]
pub fn save_server_credential(server_id: &str, credential_type: &str, secret: &str) -> Result<(), String> {
    let service = format!("vessel-ssh:{}", server_id);
    let entry = Entry::new(&service, credential_type).map_err(|e| e.to_string())?;
    entry.set_password(secret).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_server_credential(server_id: &str, credential_type: &str) -> Result<String, String> {
    let service = format!("vessel-ssh:{}", server_id);
    let entry = Entry::new(&service, credential_type).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_server_credential(server_id: &str, credential_type: &str) -> Result<(), String> {
    let service = format!("vessel-ssh:{}", server_id);
    let entry = Entry::new(&service, credential_type).map_err(|e| e.to_string())?;
    // It's normal to get a NotFound error if it's already gone; we map it appropriately
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn save_profiles(app_handle: tauri::AppHandle, json_data: String) -> Result<(), String> {
    use tauri::Manager;
    use std::fs::File;
    use std::io::Write;

    let mut config_path = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_path).map_err(|e| e.to_string())?;
    config_path.push("profiles.json");
    
    let mut file = File::create(config_path).map_err(|e| e.to_string())?;
    file.write_all(json_data.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn load_profiles(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    use std::fs::File;
    use std::io::Read;

    let mut config_path = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    config_path.push("profiles.json");
    
    if !config_path.exists() {
        return Ok("[]".to_string());
    }
    
    let mut file = File::open(config_path).map_err(|e| e.to_string())?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| e.to_string())?;
    Ok(content)
}
