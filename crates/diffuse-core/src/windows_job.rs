//! Fail-closed Windows process-tree ownership for ACP hosts and MCP Git jobs.
//! A child is suspended until assignment to a non-inheritable kill-on-close Job.
use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsHandle, AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::ptr::null;

use windows_sys::Win32::Foundation::{ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE, WAIT_TIMEOUT};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, GetProcessId, GetProcessIdOfThread, OpenThread,
    ResumeThread, THREAD_QUERY_LIMITED_INFORMATION, THREAD_SUSPEND_RESUME, WaitForSingleObject,
};

pub(crate) struct WindowsJob {
    handle: OwnedHandle,
}

impl WindowsJob {
    fn new() -> io::Result<Self> {
        // SAFETY: null attributes make an unnamed, non-inheritable handle.
        let raw = unsafe { CreateJobObjectW(null(), null()) };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: CreateJobObjectW returned a newly owned, valid handle.
        let job = Self {
            handle: unsafe { OwnedHandle::from_raw_handle(raw) },
        };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // No BREAKAWAY flags: ordinary descendants must stay in this job.
        // SAFETY: the handle and initialized buffer are valid for the call.
        if unsafe {
            SetInformationJobObject(
                job.handle.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    fn assign_and_resume(&self, process: BorrowedHandle<'_>, pid: u32) -> io::Result<()> {
        // SAFETY: borrowed process handle and owned job remain live throughout.
        if unsafe { GetProcessId(process.as_raw_handle()) } != pid || pid == 0 {
            return Err(io::Error::other("invalid suspended child identity"));
        }
        if unsafe { AssignProcessToJobObject(self.handle.as_raw_handle(), process.as_raw_handle()) }
            == 0
        {
            return Err(io::Error::last_os_error());
        }

        // Stable Rust does not expose Child's primary thread handle. Since the
        // primary thread has never run, require exactly one discoverable thread
        // owned by this PID. Reject ambiguity rather than resuming an arbitrary
        // thread or falling back to uncontained execution.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if raw == INVALID_HANDLE_VALUE || raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful snapshot creation transfers handle ownership.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut entry = THREADENTRY32 {
            dwSize: size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut thread_id = None;
        // SAFETY: snapshot and correctly sized mutable entry remain valid.
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            if entry.th32OwnerProcessID == pid && thread_id.replace(entry.th32ThreadID).is_some() {
                return Err(io::Error::other(
                    "suspended child has ambiguous primary thread",
                ));
            }
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
        }
        let last_error = io::Error::last_os_error();
        if last_error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
            return Err(last_error);
        }
        let thread_id = thread_id
            .ok_or_else(|| io::Error::other("suspended child primary thread was not found"))?;
        // SAFETY: OpenThread opens a non-inheritable handle. Identity is checked
        // again below before ResumeThread, guarding against a recycled thread ID.
        let raw = unsafe {
            OpenThread(
                THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                0,
                thread_id,
            )
        };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
        if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid
            || unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } != WAIT_TIMEOUT
        {
            return Err(io::Error::other(
                "suspended child exited or thread ownership changed",
            ));
        }
        // SAFETY: this is the verified thread of the now-contained live child.
        match unsafe { ResumeThread(thread.as_raw_handle()) } {
            1 => Ok(()),
            u32::MAX => Err(io::Error::last_os_error()),
            _ => Err(io::Error::other("unexpected primary thread suspend count")),
        }
    }

    pub async fn spawn_tokio(
        command: &mut tokio::process::Command,
    ) -> io::Result<(tokio::process::Child, Self)> {
        let job = Self::new()?;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let mut child = command.spawn()?;
        let assigned = (|| {
            let (pid, raw) = child
                .id()
                .zip(child.raw_handle())
                .ok_or_else(|| io::Error::other("missing suspended child handle"))?;
            // SAFETY: child owns raw and cannot be dropped while this call runs.
            job.assign_and_resume(unsafe { BorrowedHandle::borrow_raw(raw) }, pid)
        })();
        if let Err(error) = assigned {
            drop(job);
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error);
        }
        Ok((child, job))
    }

    pub fn spawn_std(
        command: &mut std::process::Command,
    ) -> io::Result<(std::process::Child, Self)> {
        let job = Self::new()?;
        command.creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
        let mut child = command.spawn()?;
        if let Err(error) = job.assign_and_resume(child.as_handle(), child.id()) {
            drop(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, job))
    }
    // OwnedHandle closes the last non-inherited Job handle on all exit paths,
    // including unwinding. Windows then terminates the associated process tree.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicProcessIdList, QueryInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

    #[test]
    fn contained_primary_thread_runs_only_after_assignment() {
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/D", "/C", "exit /b 0"]);
        let (mut child, _job) = WindowsJob::spawn_std(&mut command).unwrap();
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn dropping_job_terminates_parent_and_descendant() {
        let mut command = std::process::Command::new("cmd.exe");
        command.args(["/D", "/C", "ping -n 60 127.0.0.1 >NUL"]);
        let (mut child, job) = WindowsJob::spawn_std(&mut command).unwrap();
        #[repr(C)]
        struct ProcessIds {
            assigned: u32,
            count: u32,
            ids: [usize; 16],
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let handles = loop {
            let mut ids = ProcessIds {
                assigned: 0,
                count: 0,
                ids: [0; 16],
            };
            // SAFETY: buffer has the documented variable-length ID-list layout.
            assert_ne!(
                unsafe {
                    QueryInformationJobObject(
                        job.handle.as_raw_handle(),
                        JobObjectBasicProcessIdList,
                        (&mut ids as *mut ProcessIds).cast(),
                        size_of::<ProcessIds>() as u32,
                        std::ptr::null_mut(),
                    )
                },
                0
            );
            if ids.count >= 2 {
                break ids.ids[..ids.count as usize]
                    .iter()
                    .map(|pid| {
                        // SAFETY: retain process handles before dropping the job so
                        // subsequent waits cannot accidentally observe recycled PIDs.
                        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, *pid as u32) };
                        assert!(!raw.is_null());
                        unsafe { OwnedHandle::from_raw_handle(raw) }
                    })
                    .collect::<Vec<_>>();
            }
            assert!(Instant::now() < deadline, "descendant did not join job");
            std::thread::sleep(Duration::from_millis(10));
        };
        drop(job);
        for process in handles {
            assert_eq!(
                unsafe { WaitForSingleObject(process.as_raw_handle(), 5000) },
                WAIT_OBJECT_0
            );
        }
        child.wait().unwrap();
    }
}
