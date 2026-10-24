export function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

export function chunk(id, created, model, content, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      { index: 0, delta: content === "" ? {} : { content }, finish_reason: finishReason },
    ],
  })}\n\n`;
}
