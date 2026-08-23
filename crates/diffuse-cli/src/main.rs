use std::io::{self, BufRead, Write};

use diffuse_cli::RpcAdapter;
use diffuse_core::{APP_NAME, VERSION};
use serde_json::Value;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_QUEUED_REQUESTS: usize = 128;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version" | "version") => println!("{APP_NAME} {VERSION}"),
        Some("rpc") => {
            if let Err(error) = run_rpc().await {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("Usage: diffuse <rpc|version|--version>");
            std::process::exit(2);
        }
    }
}

async fn run_rpc() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let adapter = RpcAdapter::with_default_database()?;
    let mut input = input_channel();
    let mut tasks = tokio::task::JoinSet::new();
    let mut input_open = true;

    while input_open || !tasks.is_empty() {
        tokio::select! {
            next = input.recv(), if input_open && tasks.len() < MAX_IN_FLIGHT_REQUESTS => match next {
                Some(Ok(request)) => {
                    let adapter = adapter.clone();
                    tasks.spawn(async move { handle_request(adapter, request).await });
                }
                Some(Err(error)) => return Err(error.into()),
                None => input_open = false,
            },
            result = tasks.join_next(), if !tasks.is_empty() => {
                result.expect("request task set was non-empty")??;
            },
        }
    }
    Ok(())
}

async fn handle_request(
    adapter: RpcAdapter,
    request: InputRequest,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let response = match request {
        InputRequest::Line(line) => adapter.handle_line(&line).await,
        InputRequest::TooLong => Some(RpcAdapter::request_too_long_response()),
        InputRequest::InvalidUtf8 => Some(RpcAdapter::invalid_utf8_response()),
    };
    if let Some(response) = response {
        write_response(&response)?;
    }
    Ok(())
}

fn write_response(response: &Value) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

enum InputRequest {
    Line(String),
    TooLong,
    InvalidUtf8,
}

fn input_channel() -> tokio::sync::mpsc::Receiver<io::Result<InputRequest>> {
    let (sender, receiver) = tokio::sync::mpsc::channel(MAX_QUEUED_REQUESTS);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut stdin = stdin.lock();
        loop {
            match read_request(&mut stdin) {
                Ok(Some(request)) => {
                    if sender.blocking_send(Ok(request)).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    let _ = sender.blocking_send(Err(error));
                    break;
                }
            }
        }
    });
    receiver
}

fn read_request(reader: &mut impl BufRead) -> io::Result<Option<InputRequest>> {
    let mut line = Vec::new();
    let mut too_long = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() && !too_long {
                Ok(None)
            } else {
                Ok(Some(finish_request(line, too_long)))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(available.len(), |index| index + 1);
        let content = newline.map_or(available, |index| &available[..index]);
        if !too_long && line.len() + content.len() <= MAX_REQUEST_BYTES {
            line.extend_from_slice(content);
        } else {
            too_long = true;
            line.clear();
        }
        reader.consume(consumed);

        if newline.is_some() {
            return Ok(Some(finish_request(line, too_long)));
        }
    }
}

fn finish_request(line: Vec<u8>, too_long: bool) -> InputRequest {
    if too_long {
        InputRequest::TooLong
    } else {
        match String::from_utf8(line) {
            Ok(line) => InputRequest::Line(line),
            Err(_) => InputRequest::InvalidUtf8,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn oversized_request_is_bounded_and_the_next_line_remains_readable() {
        let mut input = vec![b'x'; MAX_REQUEST_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = Cursor::new(input);

        assert!(matches!(
            read_request(&mut reader).unwrap(),
            Some(InputRequest::TooLong)
        ));
        assert!(matches!(
            read_request(&mut reader).unwrap(),
            Some(InputRequest::Line(line)) if line == "{}"
        ));
    }

    #[test]
    fn invalid_utf8_is_rejected_instead_of_replaced() {
        let mut reader = Cursor::new([0xff, b'\n']);
        assert!(matches!(
            read_request(&mut reader).unwrap(),
            Some(InputRequest::InvalidUtf8)
        ));
    }
}
