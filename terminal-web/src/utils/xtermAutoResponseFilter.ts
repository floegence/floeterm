// filterXtermAutoResponses removes terminal auto-responses that should not be sent to the backend.
export const filterXtermAutoResponses = (data: string): string => {
  if (!data.includes('\x1b')) {
    return data;
  }

  let result = '';
  let i = 0;

  while (i < data.length) {
    if (data[i] === '\x1b') {
      if (i + 1 < data.length && data[i + 1] === '[') {
        const j = i + 2;

        if (j < data.length && data[j] === '?') {
          let k = j + 1;
          while (k < data.length && ((data[k] >= '0' && data[k] <= '9') || data[k] === ';')) {
            k += 1;
          }
          if (k < data.length && data[k] === 'c') {
            i = k + 1;
            continue;
          }
        }

        if (j < data.length && data[j] === '>') {
          let k = j + 1;
          while (k < data.length && ((data[k] >= '0' && data[k] <= '9') || data[k] === ';')) {
            k += 1;
          }
          if (k < data.length && data[k] === 'c') {
            i = k + 1;
            continue;
          }
        }

        if (j < data.length && data[j] >= '0' && data[j] <= '9') {
          let k = j;
          while (k < data.length && ((data[k] >= '0' && data[k] <= '9') || data[k] === ';')) {
            k += 1;
          }
          if (k < data.length && data[k] === 'R' && k > j) {
            i = k + 1;
            continue;
          }
        }

        if (j < data.length && data[j] === '?') {
          let k = j + 1;
          while (k < data.length && data[k] >= '0' && data[k] <= '9') {
            k += 1;
          }
          if (k < data.length && data[k] === 'u') {
            i = k + 1;
            continue;
          }
        }

        if (j < data.length && (data[j] === 'I' || data[j] === 'O')) {
          i = j + 1;
          continue;
        }
      }

      if (i + 1 < data.length && data[i + 1] === 'P') {
        let end = i + 2;
        while (end < data.length) {
          if (data[end] === '\x1b' && end + 1 < data.length && data[end + 1] === '\\') {
            end += 2;
            break;
          }
          if (data[end] === '\x07') {
            end += 1;
            break;
          }
          end += 1;
        }
        if (end <= data.length && end > i + 2) {
          i = end;
          continue;
        }
      }

      if (i + 1 < data.length && data[i + 1] === ']') {
        let j = i + 2;
        const codeStart = j;
        while (j < data.length && data[j] >= '0' && data[j] <= '9') {
          j += 1;
        }
        if (j > codeStart) {
          const code = Number.parseInt(data.slice(codeStart, j), 10);
          if ((code === 10 || code === 11) && j < data.length && data[j] === ';') {
            let end = j + 1;
            while (end < data.length) {
              if (data[end] === '\x07') {
                end += 1;
                break;
              }
              if (data[end] === '\x1b' && end + 1 < data.length && data[end + 1] === '\\') {
                end += 2;
                break;
              }
              end += 1;
            }
            if (end <= data.length) {
              i = end;
              continue;
            }
          }
        }
      }
    }

    result += data[i];
    i += 1;
  }

  return result;
};
