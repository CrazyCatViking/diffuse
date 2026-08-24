use std::collections::VecDeque;
use std::io::{self, BufRead, Write};

use diffuse_cli::{RpcAdapter, event_notification};
use diffuse_core::{APP_NAME, VERSION, WorkbenchEvent};
use serde_json::Value;

const MAX_REQUEST_BYTES: usize = 1024 * 1024;
const MAX_QUEUED_REQUESTS: usize = 128;
const MAX_IN_FLIGHT_REQUESTS: usize = 64;
const MAX_QUEUED_OUTPUTS: usize = 128;
const MAX_QUEUED_EVENTS: usize = 128;

type RpcResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("--version" | "version") => println!("{APP_NAME} {VERSION}"),
        Some("syntax-runner") => {
            if let Err(error) =
                diffuse_core::syntax::run_syntax_runner(io::stdin().lock(), io::stdout().lock())
            {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Some("rpc") => {
            if let Err(error) = run_rpc().await {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        _ => {
            eprintln!("Usage: diffuse <rpc|syntax-runner|version|--version>");
            std::process::exit(2);
        }
    }
}

async fn run_rpc() -> RpcResult<()> {
    let adapter = RpcAdapter::with_default_database()?;
    let (event_sequence, events, cancel_events) = adapter.subscribe_events(MAX_QUEUED_EVENTS);
    let mut input = input_channel();
    let (output, output_receiver) = tokio::sync::mpsc::channel(MAX_QUEUED_OUTPUTS);
    let writer = tokio::task::spawn_blocking(move || write_outputs(output_receiver));
    let (messages, message_receiver) = tokio::sync::mpsc::channel(MAX_QUEUED_EVENTS);
    let event_messages = messages.clone();
    let event_reader = tokio::task::spawn_blocking(move || {
        for event in events {
            if event_messages
                .blocking_send(OutputMessage::Event(event))
                .is_err()
            {
                break;
            }
        }
    });
    let mut coordinator =
        tokio::spawn(coordinate_outputs(event_sequence, message_receiver, output));
    let mut tasks = tokio::task::JoinSet::new();
    let mut input_open = true;

    while input_open || !tasks.is_empty() {
        tokio::select! {
            next = input.recv(), if input_open && tasks.len() < MAX_IN_FLIGHT_REQUESTS => match next {
                Some(Ok(request)) => {
                    let adapter = adapter.clone();
                    let messages = messages.clone();
                    tasks.spawn(async move { handle_request(adapter, request, messages).await });
                }
                Some(Err(error)) => return Err(error.into()),
                None => input_open = false,
            },
            result = tasks.join_next(), if !tasks.is_empty() => {
                result.expect("request task set was non-empty")??;
            },
            result = &mut coordinator => {
                result??;
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "output coordinator stopped before shutdown",
                ).into());
            },
        }
    }

    adapter.shutdown()?;
    let (shutdown_sender, shutdown_receiver) = tokio::sync::oneshot::channel();
    messages
        .send(OutputMessage::Shutdown {
            after_sequence: adapter.current_event_sequence(),
            completed: shutdown_sender,
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "output coordinator stopped"))?;
    drop(messages);
    shutdown_receiver.await.map_err(|_| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            "output coordinator stopped during shutdown",
        )
    })?;
    coordinator.await??;
    cancel_events();
    drop(adapter);
    event_reader.await?;
    writer.await??;
    Ok(())
}

async fn handle_request(
    adapter: RpcAdapter,
    request: InputRequest,
    messages: tokio::sync::mpsc::Sender<OutputMessage>,
) -> RpcResult<()> {
    let response = match request {
        InputRequest::Line(line) => adapter.handle_line(&line).await,
        InputRequest::TooLong => Some(RpcAdapter::request_too_long_response()),
        InputRequest::InvalidUtf8 => Some(RpcAdapter::invalid_utf8_response()),
    };
    if let Some(response) = response {
        messages
            .send(OutputMessage::Response {
                after_sequence: adapter.current_event_sequence(),
                value: response,
            })
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "output coordinator stopped"))?;
    }
    Ok(())
}

enum OutputMessage {
    Event(WorkbenchEvent),
    Response {
        after_sequence: u64,
        value: Value,
    },
    Shutdown {
        after_sequence: u64,
        completed: tokio::sync::oneshot::Sender<()>,
    },
}

async fn coordinate_outputs(
    mut delivered_sequence: u64,
    mut messages: tokio::sync::mpsc::Receiver<OutputMessage>,
    output: tokio::sync::mpsc::Sender<Value>,
) -> RpcResult<()> {
    let mut responses = VecDeque::new();
    let mut shutdown = None;

    while let Some(message) = messages.recv().await {
        match message {
            OutputMessage::Event(event) => {
                let expected = delivered_sequence.saturating_add(1);
                if event.sequence != expected {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "live event sequence violation: expected {expected}, received {}",
                            event.sequence
                        ),
                    )
                    .into());
                }
                delivered_sequence = event.sequence;
                if let Some(notification) = event_notification(event) {
                    send_output(&output, notification).await?;
                }
            }
            OutputMessage::Response {
                after_sequence,
                value,
            } => responses.push_back((after_sequence, value)),
            OutputMessage::Shutdown {
                after_sequence,
                completed,
            } => shutdown = Some((after_sequence, completed)),
        }

        while responses
            .front()
            .is_some_and(|(after_sequence, _)| *after_sequence <= delivered_sequence)
        {
            let (_, response) = responses.pop_front().expect("response queue was non-empty");
            send_output(&output, response).await?;
        }

        if shutdown.as_ref().is_some_and(|(after_sequence, _)| {
            *after_sequence <= delivered_sequence && responses.is_empty()
        }) {
            let (_, completed) = shutdown.take().expect("shutdown was present");
            let _ = completed.send(());
            return Ok(());
        }
    }

    Err(io::Error::new(
        io::ErrorKind::BrokenPipe,
        "output message channel closed before shutdown",
    )
    .into())
}

async fn send_output(output: &tokio::sync::mpsc::Sender<Value>, value: Value) -> RpcResult<()> {
    output
        .send(value)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "stdout writer stopped"))?;
    Ok(())
}

fn write_outputs(mut output: tokio::sync::mpsc::Receiver<Value>) -> RpcResult<()> {
    while let Some(value) = output.blocking_recv() {
        write_response(&value)?;
    }
    Ok(())
}

fn write_response(response: &Value) -> RpcResult<()> {
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
    use std::time::Duration;

    use super::*;
    use serde_json::json;

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

    #[tokio::test]
    async fn slow_bounded_output_preserves_more_than_replay_capacity_and_response_order() {
        const EVENT_COUNT: u64 = 2_048;

        let (message_sender, message_receiver) = tokio::sync::mpsc::channel(8);
        let (output_sender, mut output_receiver) = tokio::sync::mpsc::channel(8);
        let coordinator = tokio::spawn(coordinate_outputs(0, message_receiver, output_sender));
        let producer = tokio::spawn(async move {
            for sequence in 1..=EVENT_COUNT {
                message_sender
                    .send(OutputMessage::Event(WorkbenchEvent {
                        sequence,
                        event_id: sequence.to_string(),
                        kind: "search/progress".to_owned(),
                        workspace_id: None,
                        workspace_generation: None,
                        payload: json!({ "index": sequence - 1 }),
                    }))
                    .await
                    .unwrap();
            }
            message_sender
                .send(OutputMessage::Response {
                    after_sequence: EVENT_COUNT,
                    value: json!({ "jsonrpc": "2.0", "id": 1, "result": "survived" }),
                })
                .await
                .unwrap();
            let (completed, receiver) = tokio::sync::oneshot::channel();
            message_sender
                .send(OutputMessage::Shutdown {
                    after_sequence: EVENT_COUNT,
                    completed,
                })
                .await
                .unwrap();
            receiver.await.unwrap();
        });

        let mut outputs = Vec::new();
        while let Some(output) = output_receiver.recv().await {
            std::thread::sleep(Duration::from_micros(50));
            outputs.push(output);
        }
        producer.await.unwrap();
        coordinator.await.unwrap().unwrap();

        assert_eq!(outputs.len(), EVENT_COUNT as usize + 1);
        assert_eq!(outputs.last().unwrap()["result"], "survived");
        assert_eq!(
            outputs[..EVENT_COUNT as usize]
                .iter()
                .map(|output| output["params"]["index"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            (0..EVENT_COUNT).collect::<Vec<_>>()
        );
    }
}
