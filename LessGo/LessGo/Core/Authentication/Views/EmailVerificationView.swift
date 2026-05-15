import SwiftUI
import UIKit

struct EmailVerificationView: View {
    @EnvironmentObject var authVM: AuthViewModel
    @Environment(\.dismiss) private var dismiss

    let email: String

    @State private var otpDigits = Array(repeating: "", count: 6)
    @FocusState private var focusedIndex: Int?

    @State private var resendCooldown = 0
    @State private var cooldownTimer: Timer?
    @State private var resendSuccessMessage: String?

    private var otp: String { otpDigits.joined() }
    private var isComplete: Bool { otpDigits.allSatisfy { $0.count == 1 } }

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

                    // OTP input
                    VStack(spacing: 24) {
                        HStack(spacing: 10) {
                            ForEach(0..<6, id: \.self) { i in
                                OTPDigitField(
                                    digit: $otpDigits[i],
                                    isFocused: focusedIndex == i
                                )
                                .focused($focusedIndex, equals: i)
                                .onChange(of: otpDigits[i]) { _, val in
                                    handleDigitChange(index: i, value: val)
                                }
                            }
                        }

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
                            Task { await authVM.verifyEmail(email: email, otp: otp) }
                        }

                        // Resend
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
            .background(
                ZStack {
                    Color.appBackground.ignoresSafeArea()
                    Circle()
                        .fill(DesignSystem.Colors.accentLime.opacity(0.10))
                        .frame(width: 260)
                        .offset(x: 130, y: 480)
                        .ignoresSafeArea()
                }
            )
            .scrollDismissesKeyboard(.interactively)
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
            .onAppear { focusedIndex = 0 }
            .onChange(of: authVM.isAuthenticated) { _, verified in
                if verified { dismiss() }
            }
        }
    }

    private func handleDigitChange(index: Int, value: String) {
        authVM.errorMessage = nil
        resendSuccessMessage = nil

        // Handle paste of full 6-digit code
        if value.count == 6, value.allSatisfy(\.isNumber) {
            let digits = Array(value)
            for i in 0..<6 { otpDigits[i] = String(digits[i]) }
            focusedIndex = nil
            return
        }

        // Keep only last character
        if value.count > 1 {
            otpDigits[index] = String(value.last!)
        }

        if !value.isEmpty && index < 5 {
            focusedIndex = index + 1
        }
    }

    private func handleResend() {
        guard resendCooldown == 0 else { return }
        resendSuccessMessage = nil
        Task {
            await authVM.resendOtp(email: email)
            if authVM.errorMessage == nil {
                resendSuccessMessage = "New code sent to your email"
                startCooldown(seconds: 60)
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

// MARK: - Single OTP digit field

private struct OTPDigitField: View {
    @Binding var digit: String
    let isFocused: Bool

    var body: some View {
        TextField("", text: $digit)
            .keyboardType(.numberPad)
            .multilineTextAlignment(.center)
            .font(.system(size: 24, weight: .bold, design: .rounded))
            .foregroundColor(.white)
            .frame(width: 46, height: 56)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.appBackground)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(
                                isFocused ? DesignSystem.Colors.accentLime : DesignSystem.Colors.border.opacity(0.6),
                                lineWidth: isFocused ? 2 : 1
                            )
                    )
            )
    }
}
