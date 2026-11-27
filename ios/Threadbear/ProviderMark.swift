import SwiftUI

/// Monochrome provider mark matching the desktop app's SVG icons (24×24 viewBox).
struct ProviderMark: View {
    let provider: String
    var size: CGFloat = 14

    var body: some View {
        if let d = Self.pathData(for: provider) {
            SVGPathShape(d: d, viewBox: 24)
                .fill(style: FillStyle(eoFill: true))
                .frame(width: size, height: size)
        } else {
            Image(systemName: "sparkles")
                .font(.system(size: size * 0.85, weight: .medium))
                .frame(width: size, height: size)
        }
    }

    static func pathData(for provider: String) -> String? {
        switch provider.lowercased() {
        case "claude", "":
            return "M13.827 3.52h3.603L24 20h-3.603l-6.57-16.48zm-7.258 0h3.767L16.906 20h-3.674l-1.343-3.461H5.017l-1.344 3.46H0L6.57 3.522zm4.132 9.959L8.453 7.687 6.205 13.48H10.7z"
        case "codex":
            return "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
        case "gemini":
            return "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"
        case "opencode":
            return "M16 6H8v12h8V6zm4 16H4V2h16v20z"
        case "grok":
            return "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"
        default:
            return nil
        }
    }
}

/// Minimal SVG path parser for monochrome 24×24 provider marks.
private nonisolated struct SVGPathShape: Shape {
    let d: String
    let viewBox: CGFloat

    nonisolated func path(in rect: CGRect) -> Path {
        let base = SVGPathParser.parse(d)
        let sx = rect.width / viewBox
        let sy = rect.height / viewBox
        let scale = min(sx, sy)
        let tx = rect.minX + (rect.width - viewBox * scale) / 2
        let ty = rect.minY + (rect.height - viewBox * scale) / 2
        let transform = CGAffineTransform(translationX: tx, y: ty).scaledBy(x: scale, y: scale)
        return base.applying(transform)
    }
}

private nonisolated enum SVGPathParser {
    static func parse(_ d: String) -> Path {
        let chars = Array(d.unicodeScalars)
        var i = 0
        var path = Path()
        var cur = CGPoint.zero
        var start = CGPoint.zero
        var lastControl = CGPoint.zero
        var lastCmd: UnicodeScalar = " "
        var cmd: UnicodeScalar = " "

        func skipSep() {
            while i < chars.count {
                let c = chars[i]
                if c == " " || c == "\t" || c == "\n" || c == "\r" || c == "," { i += 1 } else { break }
            }
        }

        func isLetter(_ c: UnicodeScalar) -> Bool {
            (c >= "A" && c <= "Z") || (c >= "a" && c <= "z")
        }

        func readNumber() -> Double? {
            skipSep()
            guard i < chars.count else { return nil }
            let startIdx = i
            if chars[i] == "+" || chars[i] == "-" { i += 1 }
            var hasDigits = false
            while i < chars.count, chars[i] >= "0" && chars[i] <= "9" { i += 1; hasDigits = true }
            if i < chars.count, chars[i] == "." {
                i += 1
                while i < chars.count, chars[i] >= "0" && chars[i] <= "9" { i += 1; hasDigits = true }
            }
            guard hasDigits else { i = startIdx; return nil }
            if i < chars.count, chars[i] == "e" || chars[i] == "E" {
                let expIdx = i
                i += 1
                if i < chars.count, chars[i] == "+" || chars[i] == "-" { i += 1 }
                var expDigits = false
                while i < chars.count, chars[i] >= "0" && chars[i] <= "9" { i += 1; expDigits = true }
                if !expDigits { i = expIdx }
            }
            let s = String(String.UnicodeScalarView(chars[startIdx..<i]))
            return Double(s)
        }

        func readFlag() -> Int? {
            skipSep()
            guard i < chars.count else { return nil }
            if chars[i] == "0" { i += 1; return 0 }
            if chars[i] == "1" { i += 1; return 1 }
            return nil
        }

        func hasMoreNumbers() -> Bool {
            skipSep()
            guard i < chars.count else { return false }
            let c = chars[i]
            return (c >= "0" && c <= "9") || c == "." || c == "+" || c == "-"
        }

        while true {
            skipSep()
            guard i < chars.count else { break }
            if isLetter(chars[i]) {
                cmd = chars[i]
                i += 1
            } else if cmd == " " {
                break
            }

            switch cmd {
            case "M", "m":
                let rel = cmd == "m"
                guard let x = readNumber(), let y = readNumber() else { break }
                let pt = CGPoint(x: rel ? cur.x + x : x, y: rel ? cur.y + y : y)
                path.move(to: pt)
                cur = pt
                start = pt
                lastControl = pt
                lastCmd = cmd
                // Subsequent coordinate pairs after M/m are treated as L/l.
                cmd = rel ? "l" : "L"

            case "L", "l":
                let rel = cmd == "l"
                while hasMoreNumbers() {
                    guard let x = readNumber(), let y = readNumber() else { break }
                    let pt = CGPoint(x: rel ? cur.x + x : x, y: rel ? cur.y + y : y)
                    path.addLine(to: pt)
                    cur = pt
                    lastControl = pt
                    lastCmd = cmd
                }

            case "H", "h":
                let rel = cmd == "h"
                while hasMoreNumbers() {
                    guard let x = readNumber() else { break }
                    let pt = CGPoint(x: rel ? cur.x + x : x, y: cur.y)
                    path.addLine(to: pt)
                    cur = pt
                    lastControl = pt
                    lastCmd = cmd
                }

            case "V", "v":
                let rel = cmd == "v"
                while hasMoreNumbers() {
                    guard let y = readNumber() else { break }
                    let pt = CGPoint(x: cur.x, y: rel ? cur.y + y : y)
                    path.addLine(to: pt)
                    cur = pt
                    lastControl = pt
                    lastCmd = cmd
                }

            case "C", "c":
                let rel = cmd == "c"
                while hasMoreNumbers() {
                    guard let x1 = readNumber(), let y1 = readNumber(),
                          let x2 = readNumber(), let y2 = readNumber(),
                          let x = readNumber(), let y = readNumber() else { break }
                    let c1 = CGPoint(x: rel ? cur.x + x1 : x1, y: rel ? cur.y + y1 : y1)
                    let c2 = CGPoint(x: rel ? cur.x + x2 : x2, y: rel ? cur.y + y2 : y2)
                    let to = CGPoint(x: rel ? cur.x + x : x, y: rel ? cur.y + y : y)
                    path.addCurve(to: to, control1: c1, control2: c2)
                    cur = to
                    lastControl = c2
                    lastCmd = cmd
                }

            case "S", "s":
                let rel = cmd == "s"
                while hasMoreNumbers() {
                    guard let x2 = readNumber(), let y2 = readNumber(),
                          let x = readNumber(), let y = readNumber() else { break }
                    let c1: CGPoint
                    if lastCmd == "C" || lastCmd == "c" || lastCmd == "S" || lastCmd == "s" {
                        c1 = CGPoint(x: 2 * cur.x - lastControl.x, y: 2 * cur.y - lastControl.y)
                    } else {
                        c1 = cur
                    }
                    let c2 = CGPoint(x: rel ? cur.x + x2 : x2, y: rel ? cur.y + y2 : y2)
                    let to = CGPoint(x: rel ? cur.x + x : x, y: rel ? cur.y + y : y)
                    path.addCurve(to: to, control1: c1, control2: c2)
                    cur = to
                    lastControl = c2
                    lastCmd = cmd
                }

            case "A", "a":
                let rel = cmd == "a"
                while hasMoreNumbers() {
                    guard let rx = readNumber(), let ry = readNumber(),
                          let xAxisRot = readNumber(),
                          let largeArc = readFlag(), let sweep = readFlag(),
                          let x = readNumber(), let y = readNumber() else { break }
                    let to = CGPoint(x: rel ? cur.x + x : x, y: rel ? cur.y + y : y)
                    addSVGArc(to: &path, from: cur, to: to, rx: rx, ry: ry,
                              xAxisRotationDeg: xAxisRot, largeArc: largeArc != 0, sweep: sweep != 0)
                    cur = to
                    lastControl = to
                    lastCmd = cmd
                }

            case "Z", "z":
                path.closeSubpath()
                cur = start
                lastControl = start
                lastCmd = cmd
                cmd = " "

            default:
                cmd = " "
            }
        }
        return path
    }

    /// W3C SVG 1.1 Appendix F.6.5/F.6.6 endpoint-to-center arc conversion into cubic Beziers.
    private static func addSVGArc(
        to path: inout Path,
        from p1: CGPoint,
        to p2: CGPoint,
        rx rxIn: Double,
        ry ryIn: Double,
        xAxisRotationDeg: Double,
        largeArc: Bool,
        sweep: Bool
    ) {
        if p1 == p2 { return }
        var rx = abs(rxIn), ry = abs(ryIn)
        if rx == 0 || ry == 0 {
            path.addLine(to: p2)
            return
        }
        let phi = xAxisRotationDeg * .pi / 180.0
        let cosPhi = cos(phi), sinPhi = sin(phi)
        let dx2 = (p1.x - p2.x) / 2.0
        let dy2 = (p1.y - p2.y) / 2.0
        let x1p = cosPhi * dx2 + sinPhi * dy2
        let y1p = -sinPhi * dx2 + cosPhi * dy2

        var rxSq = rx * rx, rySq = ry * ry
        let x1pSq = x1p * x1p, y1pSq = y1p * y1p
        let lambda = x1pSq / rxSq + y1pSq / rySq
        if lambda > 1.0 {
            let s = sqrt(lambda)
            rx *= s
            ry *= s
            rxSq = rx * rx
            rySq = ry * ry
        }

        let num = max(0.0, rxSq * rySq - rxSq * y1pSq - rySq * x1pSq)
        let den = rxSq * y1pSq + rySq * x1pSq
        let factor = (largeArc == sweep ? -1.0 : 1.0) * sqrt(den == 0 ? 0 : num / den)
        let cxp = factor * (rx * y1p / ry)
        let cyp = factor * (-ry * x1p / rx)

        let cx = cosPhi * cxp - sinPhi * cyp + (p1.x + p2.x) / 2.0
        let cy = sinPhi * cxp + cosPhi * cyp + (p1.y + p2.y) / 2.0

        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            let dot = ux * vx + uy * vy
            let len = sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            let clamped = max(-1.0, min(1.0, len == 0 ? 1.0 : dot / len))
            let sign = (ux * vy - uy * vx) < 0 ? -1.0 : 1.0
            return sign * acos(clamped)
        }

        let ux = (x1p - cxp) / rx
        let uy = (y1p - cyp) / ry
        let vx = (-x1p - cxp) / rx
        let vy = (-y1p - cyp) / ry

        let theta1 = angle(1, 0, ux, uy)
        var dTheta = angle(ux, uy, vx, vy)
        if !sweep && dTheta > 0 { dTheta -= 2.0 * .pi }
        else if sweep && dTheta < 0 { dTheta += 2.0 * .pi }

        let segments = max(1, Int(ceil(abs(dTheta) / (.pi / 2.0))))
        let delta = dTheta / Double(segments)
        let t = (4.0 / 3.0) * tan(delta / 4.0)

        for seg in 0..<segments {
            let a1 = theta1 + Double(seg) * delta
            let a2 = a1 + delta
            let cos1 = cos(a1), sin1 = sin(a1)
            let cos2 = cos(a2), sin2 = sin(a2)

            let e1x = cos1, e1y = sin1
            let e2x = cos2, e2y = sin2
            let q1x = e1x - t * sin1, q1y = e1y + t * cos1
            let q2x = e2x + t * sin2, q2y = e2y - t * cos2

            func map(_ x: Double, _ y: Double) -> CGPoint {
                let sx = x * rx, sy = y * ry
                return CGPoint(x: cosPhi * sx - sinPhi * sy + cx, y: sinPhi * sx + cosPhi * sy + cy)
            }

            path.addCurve(to: map(e2x, e2y), control1: map(q1x, q1y), control2: map(q2x, q2y))
        }
    }
}
