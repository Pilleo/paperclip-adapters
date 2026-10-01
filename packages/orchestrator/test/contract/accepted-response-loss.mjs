/** External protocol fault: commit remotely, disconnect before acknowledgement, hold evidence until released. */
export function createAcceptedResponseLoss(enabled) {
  let responseLost = false;
  let observationsHeld = false;
  return {
    get responseLost() { return responseLost; },
    get observationsHeld() { return observationsHeld; },
    releaseObservations() { observationsHeld = false; },
    respond(response, accept) {
      accept();
      if (enabled && !responseLost) {
        responseLost = true;
        observationsHeld = true;
        response.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    },
  };
}
