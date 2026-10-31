//! Source-contract pins for the close-to-tray behavior (mirrors
//! trayToQuit.test.ts on the JS side). Compile-time only — no runtime
//! asserts needed beyond what cargo check enforces; these tests pin the
//! WIRING STRINGS the JS contract test checks from the other side, so a
//! rename here fails CI loudly instead of shipping a dead menu id.

#[cfg(test)]
mod tests {
    use std::include_str;

    #[test]
    fn tray_menu_has_show_and_quit_ids() {
        let src = include_str!("tray.rs");
        assert!(
            src.contains(r#"MenuItem::with_id(app, "show", "Show KAI""#),
            "tray menu must keep the 'show' item id"
        );
        assert!(
            src.contains(r#"MenuItem::with_id(app, "quit", "Quit KAI""#),
            "tray menu must keep the 'quit' item id — the ONLY true exit"
        );
    }

    #[test]
    fn quit_exits_via_app_exit_not_window_close() {
        // app.exit bypasses CloseRequested; window.close() would be
        // intercepted by the hide guard and Quit would silently do nothing.
        let src = include_str!("tray.rs");
        assert!(src.contains("app.exit(0);"), "quit must call app.exit(0)");
        assert!(!src.contains("win.close()"), "quit must NOT call win.close()");
    }

    #[test]
    fn close_backstop_hides_instead_of_closing() {
        let src = include_str!("tray.rs");
        assert!(src.contains("api.prevent_close()"));
        assert!(src.contains("win.hide()"));
    }

    #[test]
    fn close_backstop_only_guards_the_main_window() {
        // Settings windows close for real — a hidden settings husk is the
        // self-heal case open_settings_window already fights.
        let src = include_str!("tray.rs");
        assert!(src.contains(r#"if label != "main" { "#) || src.contains(r#"if label != "main""#));
    }
}
