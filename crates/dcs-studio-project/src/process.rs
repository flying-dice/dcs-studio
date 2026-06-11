//! Child-process plumbing shared by toolchain probes and build spawns.

use std::process::Command;

/// A [`Command`] that never flashes a console window: on Windows the
/// child is created with `CREATE_NO_WINDOW` (vital under a windowed
/// app like the IDE, where each bare spawn pops a console); elsewhere
/// it is a plain `Command`.
#[must_use]
pub fn quiet_command(program: &str) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_command_keeps_the_program() {
        assert_eq!(quiet_command("cargo").get_program(), "cargo");
    }
}
