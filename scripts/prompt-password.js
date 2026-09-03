// Reads a password from stdin without echoing it.
//
// Two paths, because readline's question() does not survive piped input reaching EOF,
// and terminal echo can only be suppressed by putting a TTY into raw mode:
//   - interactive terminal: raw mode, read a character at a time, echo nothing
//   - piped or redirected:  read a line, nothing is echoed anyway
const CTRL_C    = '\u0003';   // interrupt
const CTRL_D    = '\u0004';   // end of transmission
const BACKSPACE = '\u007f';   // delete

function readFromTty(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);

    const wasRaw = Boolean(stdin.isRaw);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';

    function cleanup() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    }

    function onData(chunk) {
      // A chunk can hold several characters at once, for instance on paste.
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === CTRL_D) {
          cleanup();
          process.stdout.write('\n');
          return resolve(value);
        }
        if (char === CTRL_C) {
          cleanup();
          process.stdout.write('\n');
          return reject(new Error('Cancelled. Nothing was changed.'));
        }
        if (char === BACKSPACE || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        // Skip any remaining control characters, such as arrow-key escapes.
        if (char < ' ') continue;
        value += char;
      }
    }

    stdin.on('data', onData);
  });
}

// Buffers all of stdin once, then hands out one line per call. Reading it in pieces
// across two separate readline interfaces is what loses input when stdin is a pipe.
let pipedLines = null;
let pipedIndex = 0;

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

async function readFromPipe(prompt) {
  if (pipedLines === null) {
    pipedLines = (await readAllStdin()).split('\n');
  }
  process.stdout.write(prompt + '\n');
  if (pipedIndex >= pipedLines.length) throw new Error('No more input. Nothing was changed.');
  return pipedLines[pipedIndex++].replace(/\r$/, '');
}

function promptPassword(prompt) {
  return process.stdin.isTTY ? readFromTty(prompt) : readFromPipe(prompt);
}

module.exports = { promptPassword };
