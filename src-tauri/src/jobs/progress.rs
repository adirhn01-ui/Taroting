//! Parser for ffmpeg `-progress pipe:1` output: `key=value` lines, one block
//! per update, terminated by a `progress=continue|end` line.

#[derive(Debug, Default, Clone)]
pub struct Progress {
    pub out_time_us: Option<u64>,
    pub fps: Option<f64>,
    pub speed: Option<f64>,
    pub end: bool,
}

/// Feed one line. Returns true when a block just completed (a `progress=`
/// line was seen) and the accumulated state is ready to publish.
pub fn parse_line(line: &str, state: &mut Progress) -> bool {
    let Some((key, value)) = line.split_once('=') else {
        return false;
    };
    let value = value.trim();
    match key.trim() {
        "out_time_us" | "out_time_ms" => {
            // Despite the name, ffmpeg emits MICROseconds for both keys.
            state.out_time_us = value.parse::<i64>().ok().map(|v| v.max(0) as u64);
        }
        "fps" => {
            state.fps = value.parse().ok();
        }
        "speed" => {
            // e.g. "3.21x" or "N/A"
            state.speed = value.trim_end_matches('x').parse().ok();
        }
        "progress" => {
            state.end = value == "end";
            return true;
        }
        _ => {}
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "\
frame=120
fps=59.88
stream_0_0_q=23.0
bitrate=1544.6kbits/s
total_size=786432
out_time_us=4066667
out_time_ms=4066667
out_time=00:00:04.066667
dup_frames=0
drop_frames=0
speed=3.98x
progress=continue
frame=240
fps=60.02
out_time_us=8066667
out_time_ms=8066667
speed=N/A
progress=end
";

    #[test]
    fn parses_blocks_and_final_state() {
        let mut state = Progress::default();
        let mut blocks = 0;
        for line in FIXTURE.lines() {
            if parse_line(line, &mut state) {
                blocks += 1;
                if blocks == 1 {
                    assert_eq!(state.out_time_us, Some(4_066_667));
                    assert_eq!(state.speed, Some(3.98));
                    assert!((state.fps.unwrap() - 59.88).abs() < 1e-9);
                    assert!(!state.end);
                }
            }
        }
        assert_eq!(blocks, 2);
        assert!(state.end);
        assert_eq!(state.out_time_us, Some(8_066_667));
        // N/A speed parses to None
        assert_eq!(state.speed, None);
    }

    #[test]
    fn ignores_garbage() {
        let mut state = Progress::default();
        assert!(!parse_line("not a kv line", &mut state));
        assert!(!parse_line("out_time_us=N/A", &mut state));
        assert_eq!(state.out_time_us, None);
    }
}
