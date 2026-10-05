//! The browser's time zone, for the formats that write local wall-clock times.

use can_formats::LocalTime;

/// The time zone of the browser running the worker. Native builds (the tests) use UTC.
pub fn local_time() -> LocalTime {
    #[cfg(target_arch = "wasm32")]
    {
        LocalTime(browser::utc_offset_s)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        LocalTime::UTC
    }
}

#[cfg(target_arch = "wasm32")]
mod browser {
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    extern "C" {
        type Date;

        #[wasm_bindgen(constructor)]
        fn new(ms: f64) -> Date;

        #[wasm_bindgen(method, js_name = getTimezoneOffset)]
        fn get_timezone_offset(this: &Date) -> f64;
    }

    /// The offset of local time from UTC at a Unix time, in seconds. JavaScript gives it in
    /// minutes, the other way round, and NaN for a time outside its range.
    pub fn utc_offset_s(unix_s: i64) -> i64 {
        let minutes = Date::new(unix_s as f64 * 1000.0).get_timezone_offset();
        if minutes.is_finite() {
            (-minutes * 60.0).round() as i64
        } else {
            0
        }
    }
}
