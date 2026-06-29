pub mod keychain;
pub mod ssh;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            keychain::save_server_credential,
            keychain::get_server_credential,
            keychain::delete_server_credential,
            keychain::save_profiles,
            keychain::load_profiles,
            keychain::save_git_repos,
            keychain::load_git_repos,
            ssh::connect_session,
            ssh::disconnect_session,
            ssh::execute_command,
            ssh::write_remote_file,
            ssh::read_remote_file,
            ssh::start_terminal_session,
            ssh::write_terminal_data,
            ssh::list_directory,
            ssh::chmod_file,
            ssh::create_directory,
            ssh::delete_file_or_directory,
            ssh::control_service,
            ssh::get_service_logs,
            ssh::control_container,
            ssh::get_container_logs,
            ssh::start_container_logs_stream,
            ssh::stop_container_logs_stream,
            ssh::start_command_stream,
            ssh::configure_proxy,
            ssh::resize_terminal_session,
            ssh::confirm_host_key,
            ssh::close_terminal_session,
            ssh::list_proxies,
            ssh::delete_proxy,
            ssh::toggle_proxy_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
