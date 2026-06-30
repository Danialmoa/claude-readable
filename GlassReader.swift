import Cocoa
import WebKit

// A borderless, floating, frosted-glass panel that hosts a transparent WKWebView.
// Usage: GlassReader <html-file>
final class GlassWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// Lets the page ask the app to close (the ✕ button) via webkit.messageHandlers.control.
final class Bridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        if (message.body as? String) == "close" { NSApp.terminate(nil) }
    }
}

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: GlassReader <html-file>\n".data(using: .utf8)!)
    exit(1)
}
let fileURL = URL(fileURLWithPath: args[1])

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no dock icon

let screen = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
let w = min(CGFloat(800), screen.width * 0.52)
let h = screen.height * 0.86
let rect = NSRect(x: screen.midX - w / 2, y: screen.midY - h / 2, width: w, height: h)

let win = GlassWindow(contentRect: rect,
                      styleMask: [.borderless, .resizable],
                      backing: .buffered, defer: false)
win.isOpaque = false
win.backgroundColor = .clear
win.hasShadow = true
win.level = .floating
win.isMovableByWindowBackground = false   // allow click-drag text selection (+ ⌘C)
win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

// Frosted glass: blurs whatever is behind the window (your terminal).
let blur = NSVisualEffectView(frame: NSRect(origin: .zero, size: rect.size))
blur.material = .hudWindow
blur.blendingMode = .behindWindow
blur.state = .active
blur.wantsLayer = true
blur.layer?.cornerRadius = 22
blur.layer?.masksToBounds = true
blur.autoresizingMask = [.width, .height]

// Transparent web view so the glass shows through behind the text.
let config = WKWebViewConfiguration()
let bridge = Bridge()
config.userContentController.add(bridge, name: "control")
let web = WKWebView(frame: blur.bounds, configuration: config)
web.autoresizingMask = [.width, .height]
web.setValue(false, forKey: "drawsBackground")  // transparent background
web.loadFileURL(fileURL, allowingReadAccessTo: fileURL.deletingLastPathComponent())
blur.addSubview(web)
win.contentView = blur

// Esc or Cmd-W dismisses; everything else (incl. +/- for font size) reaches the page.
NSEvent.addLocalMonitorForEvents(matching: .keyDown) { (event: NSEvent) -> NSEvent? in
    if event.keyCode == 53 { NSApp.terminate(nil); return nil }
    if event.modifierFlags.contains(.command),
       event.charactersIgnoringModifiers == "w" { NSApp.terminate(nil); return nil }
    return event
}

app.activate(ignoringOtherApps: true)
win.makeKeyAndOrderFront(nil)
win.makeFirstResponder(web)   // so ↑/↓/Enter reach the page without a click first
app.run()
