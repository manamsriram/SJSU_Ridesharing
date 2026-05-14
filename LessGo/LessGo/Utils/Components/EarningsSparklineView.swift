import SwiftUI

/// A minimal 7-point line chart using existing brandTeal color tokens.
struct EarningsSparklineView: View {
    let values: [Double]

    var body: some View {
        GeometryReader { geo in
            let pts = normalizedPoints(in: geo.size)
            ZStack {
                // Gradient fill under the line
                LinearGradient(
                    colors: [Color.brandTeal.opacity(0.35), Color.brandTeal.opacity(0.0)],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .mask(fillPath(pts: pts, size: geo.size))

                // Line stroke
                linePath(pts: pts)
                    .stroke(Color.brandTeal, style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
            }
        }
    }

    // MARK: - Helpers

    private func normalizedPoints(in size: CGSize) -> [CGPoint] {
        guard values.count > 1 else { return [] }
        let minV = values.min() ?? 0
        let maxV = values.max() ?? 1
        let range = maxV - minV == 0 ? 1.0 : maxV - minV
        let step = size.width / CGFloat(values.count - 1)
        return values.enumerated().map { i, v in
            CGPoint(
                x: CGFloat(i) * step,
                y: size.height - CGFloat((v - minV) / range) * size.height * 0.85 - size.height * 0.05
            )
        }
    }

    private func linePath(pts: [CGPoint]) -> Path {
        var path = Path()
        guard let first = pts.first else { return path }
        path.move(to: first)
        for pt in pts.dropFirst() { path.addLine(to: pt) }
        return path
    }

    private func fillPath(pts: [CGPoint], size: CGSize) -> Path {
        var path = linePath(pts: pts)
        guard let last = pts.last else { return path }
        path.addLine(to: CGPoint(x: last.x, y: size.height))
        path.addLine(to: CGPoint(x: 0, y: size.height))
        path.closeSubpath()
        return path
    }
}

#Preview {
    EarningsSparklineView(values: [0, 20, 15, 40, 30, 55, 70])
        .frame(height: 60)
        .padding()
        .background(Color.cardBackground)
}
