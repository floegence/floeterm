package terminal

import (
	"strconv"
)

// HistoryFilter removes sequences that should not be replayed to the frontend.
type HistoryFilter interface {
	Filter(chunks []TerminalDataChunk) []TerminalDataChunk
}

// DefaultHistoryFilter mirrors the filtering rules used by the original agent.
type DefaultHistoryFilter struct{}

// Filter removes OSC/CSI responses that would render as garbage on replay.
func (DefaultHistoryFilter) Filter(chunks []TerminalDataChunk) []TerminalDataChunk {
	if len(chunks) == 0 {
		return chunks
	}

	filtered := make([]TerminalDataChunk, 0, len(chunks))
	for _, chunk := range chunks {
		data := chunk.Data
		if len(data) == 0 {
			filtered = append(filtered, chunk)
			continue
		}

		newData := filterOSCColorSequences(data)
		if len(newData) == 0 {
			continue
		}
		newData = filterCSIDeviceAttributeSequences(newData)
		if len(newData) == 0 {
			continue
		}
		newData = filterCSICursorPositionReportSequences(newData)
		if len(newData) == 0 {
			continue
		}
		newData = filterTerminalQuerySequences(newData)
		if len(newData) == 0 {
			continue
		}

		chunk.Data = newData
		filtered = append(filtered, chunk)
	}

	return filtered
}

func filterOSCColorSequences(data []byte) []byte {
	out := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		if data[i] == 0x1b && i+2 < len(data) && data[i+1] == ']' {
			j := i + 2
			for j < len(data) && data[j] == ' ' {
				j++
			}

			numStart := j
			for j < len(data) && data[j] >= '0' && data[j] <= '9' {
				j++
			}

			if numStart == j {
				out = append(out, data[i])
				i++
				continue
			}

			code, err := strconv.Atoi(string(data[numStart:j]))
			if err != nil {
				out = append(out, data[i])
				i++
				continue
			}

			if (code == 10 || code == 11) && j < len(data) && data[j] == ';' {
				end := j + 1
				for end < len(data) {
					b := data[end]
					if b == 0x07 {
						end++
						break
					}
					if b == 0x1b && end+1 < len(data) && data[end+1] == '\\' {
						end += 2
						break
					}
					end++
				}

				if end <= len(data) && end > j+1 {
					i = end
					continue
				}

				out = append(out, data[i])
				i++
				continue
			}

			out = append(out, data[i])
			i++
			continue
		}

		out = append(out, data[i])
		i++
	}

	return out
}

func filterCSIDeviceAttributeSequences(data []byte) []byte {
	out := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		if data[i] == 0x1b && i+3 < len(data) && data[i+1] == '[' && (data[i+2] == '?' || data[i+2] == '>') {
			j := i + 3
			for j < len(data) {
				b := data[j]
				if (b >= '0' && b <= '9') || b == ';' {
					j++
					continue
				}
				break
			}

			if j < len(data) && data[j] == 'c' {
				i = j + 1
				continue
			}

			out = append(out, data[i])
			i++
			continue
		}

		out = append(out, data[i])
		i++
	}

	return out
}

func filterCSICursorPositionReportSequences(data []byte) []byte {
	out := make([]byte, 0, len(data))
	i := 0
	for i < len(data) {
		if data[i] == 0x1b && i+2 < len(data) && data[i+1] == '[' {
			j := i + 2
			numStart := j
			for j < len(data) {
				b := data[j]
				if (b >= '0' && b <= '9') || b == ';' {
					j++
					continue
				}
				break
			}

			if numStart == j {
				out = append(out, data[i])
				i++
				continue
			}

			if j < len(data) && data[j] == 'R' {
				i = j + 1
				continue
			}

			out = append(out, data[i])
			i++
			continue
		}

		out = append(out, data[i])
		i++
	}

	return out
}

func filterTerminalQuerySequences(data []byte) []byte {
	out := make([]byte, 0, len(data))

	i := 0
	for i < len(data) {
		// Look for ESC
		if data[i] == 0x1b {
			// Check for CSI sequences (ESC [)
			if i+1 < len(data) && data[i+1] == '[' {
				j := i + 2

				// Primary Device Attributes: ESC [ c
				if j < len(data) && data[j] == 'c' {
					i = j + 1
					continue
				}

				// Secondary Device Attributes: ESC [ > c or ESC [ > 0 c
				if j < len(data) && data[j] == '>' {
					k := j + 1
					// Skip optional digits
					for k < len(data) && data[k] >= '0' && data[k] <= '9' {
						k++
					}
					if k < len(data) && data[k] == 'c' {
						i = k + 1
						continue
					}
				}

				// Cursor Position Report query (DSR-6): ESC [ 6 n
				if j < len(data) && data[j] == '6' {
					k := j + 1
					if k < len(data) && data[k] == 'n' {
						i = k + 1
						continue
					}
				}

				// Kitty keyboard protocol query: ESC [ ? u
				if j < len(data) && data[j] == '?' {
					k := j + 1
					// Skip optional digits (for ESC [ ? Ps u)
					for k < len(data) && data[k] >= '0' && data[k] <= '9' {
						k++
					}
					if k < len(data) && data[k] == 'u' {
						i = k + 1
						continue
					}
				}

				// DECRQM (Request Mode): ESC [ ? Ps $ p
				if j < len(data) && data[j] == '?' {
					k := j + 1
					// Skip digits and semicolons
					for k < len(data) && ((data[k] >= '0' && data[k] <= '9') || data[k] == ';') {
						k++
					}
					if k < len(data) && data[k] == '$' && k+1 < len(data) && data[k+1] == 'p' {
						i = k + 2
						continue
					}
				}

				// Focus reporting enable: ESC [ ? 1004 h or l
				if j < len(data) && data[j] == '?' {
					k := j + 1
					if k+4 <= len(data) && data[k] == '1' && data[k+1] == '0' && data[k+2] == '0' && data[k+3] == '4' {
						if k+4 < len(data) && (data[k+4] == 'h' || data[k+4] == 'l') {
							i = k + 5
							continue
						}
					}
				}

				// XTVERSION query: ESC [ > 0 q or ESC [ > q
				if j < len(data) && data[j] == '>' {
					k := j + 1
					// Skip optional digits
					for k < len(data) && data[k] >= '0' && data[k] <= '9' {
						k++
					}
					if k < len(data) && data[k] == 'q' {
						i = k + 1
						continue
					}
				}
			}

			// Check for OSC sequences (ESC ])
			if i+1 < len(data) && data[i+1] == ']' {
				j := i + 2

				// Skip optional spaces
				for j < len(data) && data[j] == ' ' {
					j++
				}

				// Parse numeric code
				numStart := j
				for j < len(data) && data[j] >= '0' && data[j] <= '9' {
					j++
				}

				if numStart < j {
					code := 0
					for k := numStart; k < j; k++ {
						code = code*10 + int(data[k]-'0')
					}

					// OSC 10/11 with query (;?)
					if (code == 10 || code == 11) && j < len(data) && data[j] == ';' {
						if j+1 < len(data) && data[j+1] == '?' {
							// Find terminator: BEL (0x07) or ST (ESC \)
							end := j + 2
							for end < len(data) {
								if data[end] == 0x07 {
									end++
									break
								}
								if data[end] == 0x1b && end+1 < len(data) && data[end+1] == '\\' {
									end += 2
									break
								}
								end++
							}

							i = end
							continue
						}
					}
				}
			}
		}

		// Normal byte, copy through
		out = append(out, data[i])
		i++
	}

	return out
}
