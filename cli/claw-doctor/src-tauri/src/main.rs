// Prevents additional console window on Windows in release; do nothing on macOS / Linux.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    factotem_doctor_lib::run()
}
