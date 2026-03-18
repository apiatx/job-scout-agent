import app from "./app";

const port = Number(process.env["PORT"]) || 8080;
const frontendPort = 25906;

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

if (port !== frontendPort) {
  app.listen(frontendPort, () => {
    console.log(`Frontend also served on port ${frontendPort}`);
  });
}
