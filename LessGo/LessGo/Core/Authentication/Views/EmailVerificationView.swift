import SwiftUI
import UIKit

// MARK: - EmailVerificationView

struct EmailVerificationView: View {
    @EnvironmentObject var authVM: AuthViewModel
    @Environment(\.dismiss) private var dismiss

    let email: String

    @State private var code = ""
    @State private var resendCooldown = 0
    @State private var cooldownTimer: Timer?
    @State private var resendSuccessMessage: String?
    @State private var isFocused = false

    private var isComplete: Bool { code.count == 6 }

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(spacing: 0) {
                    // Header
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Check your email")
                                    .font(.system(size: 30, weight: .bold, design: .rounded))
                                    .foregroundColor(.white)
                                Text("We sent a 6-digit code to")
                                    .font(.system(size: 15))
                                    .foregroundColor(.textSecondary)
                                Text(email)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(DesignSystem.Colors.accentLime)
                            }
                            Spacer()
                            Image(systemName: "envelope.badge.fill")
                                .font(.system(size: 36))
                                .foregroundColor(DesignSystem.Colors.accentLime)
                        }
                    }
                    .padding(18)
                    .background(
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .fill(DesignSystem.Colors.darkBrandSurface)
                            .overlay(
                                RoundedRectangle(cornerRadius: 24, style: .continuous)
                                    .strokeBorder(DesignSystem.Colors.onDark.opacity(0.08), lineWidth: 1)
                            )
                    )
                    .padding(.horizontal, AppConstants.pagePadding)
                    .padding(.top, 14)

                    // OTP input card
                    VStack(spacing: 24) {
                        // Digit boxes — tap anywhere to focus the hidden field
                        OTPBoxRow(code: code, isFocused: isFocused)
                            .onTapGesture { isFocused = true }
                            .overlay(
                                HiddenOTPField(text: $code, isFocused: $isFocused)
                                    .frame(width: 1, height: 1)
                                    .opacity(0.01)
                            )

                        if let err = authVM.errorMessage {
                            ToastBanner(message: err, type: .error)
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }

                        if let msg = resendSuccessMessage {
                            ToastBanner(message: msg, type: .success)
                                .transition(.move(edge: .top).combined(with: .opacity))
                        }

                        PrimaryButton(
                            title: "Verify Email",
                            icon: "checkmark.shield.fill",
                            isLoading: authVM.isLoading,
                            isEnabled: isComplete
                        ) {
                            Task { await authVM.verifyEmail(email: email, otp: code) }
                        }

                        Button(action: handleResend) {
                            if resendCooldown > 0 {
                                Text("Resend code in \(resendCooldown)s")
                                    .font(.system(size: 14))
                                    .foregroundColor(.textTertiary)
                            } else {
                                Text("Didn't receive a code? **Resend**")
                                    .font(.system(size: 14))
                                    .foregroundColor(.textSecondary)
                            }
                        }
                        .disabled(resendCooldown > 0 || authVM.isLoading)
                    }
                    .padding(24)
                    .background(
                        RoundedRectangle(cornerRadius: 26, style: .continuous)
                            .fill(Color.cardBackground.opacity(0.97))
                            .overlay(
                                RoundedRectangle(cornerRadius: 26, style: .continuous)
                                    .strokeBorder(DesignSystem.Colors.border.opacity(0.7), lineWidth: 1)
                            )
                    )
                    .padding(.horizontal, AppConstants.pagePadding)
                    .padding(.top, 20)

                    Text("The code expires in 15 minutes.")
                        .font(.system(size: 12))
                        .foregroundColor(.textTertiary)
                        .padding(.top, 16)
                }
                .padding(.bottom, 32)
            }
            .background(Color.appBackground.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: { dismiss() }) {
                        Image(systemName: "xmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.textSecondary)
                            .padding(8)
                            .background(Color.appBackground)
                            .clipShape(Circle())
                    }
                }
            }
            .onAppear { isFocused = true }
            .onChange(of: authVM.isAuthenticated) { _, verified in
                if verified { dismiss() }
            }
            .onChange(of: code) { _, val in
                authVM.errorMessage = nil
                resendSuccessMessage = nil
                // Auto-submit when all 6 digits entered
                if val.count == 6 {
                    Task { await authVM.verifyEmail(email: email, otp: val) }
                }
            }
        }
    }

    private func handleResend() {
        guard resendCooldown == 0 else { return }
        resendSuccessMessage = nil
        authVM.errorMessage = nil
        code = ""
        Task {
            await authVM.resendOtp(email: email)
            if authVM.errorMessage == nil {
                resendSuccessMessage = "New code sent to your email"
                startCooldown(seconds: 60)
            } else {
                // Backend cooldown still active — parse seconds if available
                let msg = authVM.errorMessage ?? ""
                let seconds = msg.components(separatedBy: CharacterSet.decimalDigits.inverted)
                    .compactMap(Int.init).first ?? 60
                resendSuccessMessage = "A code was already sent recently"
                authVM.errorMessage = nil
                startCooldown(seconds: seconds)
            }
        }
    }

    private func startCooldown(seconds: Int) {
        resendCooldown = seconds
        cooldownTimer?.invalidate()
        cooldownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { t in
            DispatchQueue.main.async {
                resendCooldown -= 1
                if resendCooldown <= 0 { t.invalidate() }
            }
        }
    }
}

// MARK: - OTP Box Row (display only)

private struct OTPBoxRow: View {
    let code: String
    let isFocused: Bool

    var body: some View {
        HStack(spacing: 10) {
            ForEach(0..<6, id: \.self) { i in
                let char: String = i < code.count
                    ? String(Array(code)[i])
                    : ""
                let isActive = isFocused && i == min(code.count, 5)

                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.appBackground)
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(
                                    isActive ? DesignSystem.Colors.accentLime : DesignSystem.Colors.border.opacity(0.6),
                                    lineWidth: isActive ? 2 : 1
                                )
                        )

                    if char.isEmpty && isActive {
                        // Blinking cursor
                        BlinkingCursor()
                    } else {
                        Text(char)
                            .font(.system(size: 24, weight: .bold, design: .rounded))
                            .foregroundColor(.white)
                    }
                }
                .frame(width: 46, height: 56)
            }
        }
    }
}

// MARK: - Blinking cursor

private struct BlinkingCursor: View {
    @State private var visible = true
    var body: some View {
        Rectangle()
            .fill(DesignSystem.Colors.accentLime)
            .frame(width: 2, height: 28)
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.5).repeatForever()) {
                    visible.toggle()
                }
            }
    }
}

// MARK: - Hidden UITextField (single source of truth for input)

private struct HiddenOTPField: UIViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextField {
        let tf = UITextField()
        tf.keyboardType = .numberPad
        tf.textContentType = .oneTimeCode  // triggers SMS/email autofill
        tf.delegate = context.coordinator
        tf.tintColor = .clear
        tf.textColor = .clear
        tf.backgroundColor = .clear
        return tf
    }

    func updateUIView(_ tf: UITextField, context: Context) {
        if tf.text != text { tf.text = text }
        if isFocused && !tf.isFirstResponder {
            tf.becomeFirstResponder()
        } else if !isFocused && tf.isFirstResponder {
            tf.resignFirstResponder()
        }
    }

    class Coordinator: NSObject, UITextFieldDelegate {
        var parent: HiddenOTPField

        init(_ parent: HiddenOTPField) { self.parent = parent }

        func textField(_ tf: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            let current = tf.text ?? ""
            guard let r = Range(range, in: current) else { return false }
            let updated = current.replacingCharacters(in: r, with: string)
                .filter(\.isNumber)
            let capped = String(updated.prefix(6))
            DispatchQueue.main.async {
                self.parent.text = capped
                tf.text = capped
            }
            return false
        }

        func textFieldDidBeginEditing(_ tf: UITextField) {
            DispatchQueue.main.async { self.parent.isFocused = true }
        }

        func textFieldDidEndEditing(_ tf: UITextField) {
            DispatchQueue.main.async { self.parent.isFocused = false }
        }
    }
}
