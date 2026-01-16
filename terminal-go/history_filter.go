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
		if data[i] == 0x1b {
			if i+1 < len(data) && data[i+1] == '[' {
				j := i + 2
				if j < len(data) && data[j] == 'c' {
					i = j + 1
					continue
				}
				if j+1 < len(data) && data[j] == '>' && data[j+1] == 'c' {
					i = j + 2
					continue
				}
				if j+2 < len(data) && data[j] == '6' && data[j+1] == 'n' {
					i = j + 2
					continue
				}
				if j+1 < len(data) && data[j] == '?' && data[j+1] == 'u' {
					i = j + 2
					continue
				}
				if j+3 < len(data) && data[j] == '?' && data[j+2] == '$' && data[j+3] == 'p' {
					i = j + 4
					continue
				}
				if j+2 < len(data) && data[j] == '>' && data[j+1] == '0' && data[j+2] == 'q' {
					i = j + 3
					continue
				}
				if j+5 < len(data) && data[j] == '?' && data[j+1] == '1' && data[j+2] == '0' && data[j+3] == '0' && data[j+4] == '4' && data[j+5] == 'h' {
					i = j + 6
					continue
				}
			}

			if i+1 < len(data) && data[i+1] == ']' {
				j := i + 2
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
					i = j + 1
					continue
				}
			}
		}

		out = append(out, data[i])
		i++
	}

	return out
}
