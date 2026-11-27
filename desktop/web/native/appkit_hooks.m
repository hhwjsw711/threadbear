// The AppKit glue for running CEF inside the GPUI app on a Mac. Adapted from
// Ghostex's apps/desktop/native/macos/GpuiCefAppKitHooks.m by way of the
// gpui-web-spike branch (desktop/web-spike/native/appkit_hooks.m there), MIT
// licensed:
//
//   Copyright 2026 Mohamad Yahia (maddada)
//
//   Permission is hereby granted, free of charge, to any person obtaining a
//   copy of this software and associated documentation files (the "Software"),
//   to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense,
//   and/or sell copies of the Software, and to permit persons to whom the
//   Software is furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in
//   all copies or substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//   FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
//   DEALINGS IN THE SOFTWARE.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <stdbool.h>

// CEF's message pump traps unless NSApp conforms to CefAppProtocol
// (cef_application_mac.h). GPUI owns the NSApplication subclass, so the
// protocol and the isHandlingSendEvent state are added at run time instead.
@protocol CrAppProtocol
- (BOOL)isHandlingSendEvent;
@end
@protocol CrAppControlProtocol <CrAppProtocol>
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent;
@end
@protocol CefAppProtocol <CrAppControlProtocol>
@end

static BOOL g_handlingSendEvent = NO;

@interface NSApplication (ThreadbearCEF) <CefAppProtocol>
- (BOOL)isHandlingSendEvent;
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent;
- (void)threadbearCefSendEvent:(NSEvent *)event;
@end

@implementation NSApplication (ThreadbearCEF)
- (BOOL)isHandlingSendEvent {
  return g_handlingSendEvent;
}
- (void)setHandlingSendEvent:(BOOL)handlingSendEvent {
  g_handlingSendEvent = handlingSendEvent;
}
- (void)threadbearCefSendEvent:(NSEvent *)event {
  BOOL was = g_handlingSendEvent;
  g_handlingSendEvent = YES;
  // Swizzled: this calls the original -sendEvent:.
  [self threadbearCefSendEvent:event];
  g_handlingSendEvent = was;
}
@end

void tb_cef_install_app_hooks(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class baseClass = [NSApplication class];
    Method original = class_getInstanceMethod(baseClass, @selector(sendEvent:));
    Method swapped = class_getInstanceMethod(baseClass, @selector(threadbearCefSendEvent:));
    if (original && swapped) {
      method_exchangeImplementations(original, swapped);
    }
    class_addProtocol(baseClass, @protocol(CrAppProtocol));
    class_addProtocol(baseClass, @protocol(CrAppControlProtocol));
    class_addProtocol(baseClass, @protocol(CefAppProtocol));
  });
  // NSApp is GPUI's subclass; Chromium checks the concrete class.
  if (NSApp) {
    Class appClass = object_getClass(NSApp);
    class_addProtocol(appClass, @protocol(CrAppProtocol));
    class_addProtocol(appClass, @protocol(CrAppControlProtocol));
    class_addProtocol(appClass, @protocol(CefAppProtocol));
  }
}

// Implemented in Rust (host.rs): starts CEF, then runs Chromium's message
// loop for the rest of the process.
extern void tb_cef_run_message_loop(void);

static BOOL g_startPending = NO;
static BOOL g_loopRunning = NO;

static void tb_cef_schedule_start(CFTimeInterval delay) {
  CFRunLoopTimerRef timer = CFRunLoopTimerCreateWithHandler(
      kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + delay, 0, 0, 0,
      ^(CFRunLoopTimerRef firedTimer) {
        (void)firedTimer;
        if (!g_startPending) {
          return;
        }
        // Not inside a modal session (an alert, a save panel): Chromium's
        // loop would end up nested in it.
        if (NSApp.modalWindow != nil) {
          tb_cef_schedule_start(0.25);
          return;
        }
        g_startPending = NO;
        g_loopRunning = YES;
        tb_cef_run_message_loop();
        g_loopRunning = NO;
      });
  CFRunLoopAddTimer(CFRunLoopGetMain(), timer, kCFRunLoopDefaultMode);
  CFRelease(timer);
}

// Why a CFRunLoopTimer and never a main-queue block: Chromium's loop then
// runs inside this one callout for the rest of the process, and it has to be
// entered from a run-loop pass rather than a GCD block, or GPUI's main-queue
// work (every foreground task) would stop being serviced (Ghostex's note on
// this, 2026-10-17; the spike found the same).
void tb_cef_start_message_loop(void) {
  if (g_startPending || g_loopRunning) {
    return;
  }
  g_startPending = YES;
  tb_cef_schedule_start(0);
  CFRunLoopWakeUp(CFRunLoopGetMain());
}

// Chromium sizes the layer it shows a page's picture in by Core Animation's
// autoresizing alone (display_ca_layer_tree.mm: the flipped layer is width and
// height sizable, and on the Mac nothing ever sets its bounds). Autoresizing
// only adds each change of its parent's size to what it has, so an error
// stays, and GPUI's slots come in half points: every move or resize of a
// panel's page could leave a little behind. After a morning of panels moving
// it was 12 points or more, and as the layer hangs from the bottom of a
// clipping one, the page was drawn that much too high while Chromium read
// clicks where the view really is: each press landed above the pointer, the
// top of a button did nothing, and a drag selected from the line above (Mike,
// 16 Nov). So each time the view is placed, every such layer is put back to
// its parent's exact size.
static void tb_pin_flipped_layers(CALayer *layer, int depth) {
  for (CALayer *sub in layer.sublayers) {
    CAAutoresizingMask sizable = kCALayerWidthSizable | kCALayerHeightSizable;
    if (sub.geometryFlipped && (sub.autoresizingMask & sizable) == sizable && !CGRectEqualToRect(sub.frame, layer.bounds)) {
      sub.frame = layer.bounds;
    }
    if (depth < 6) {
      tb_pin_flipped_layers(sub, depth + 1);
    }
  }
}

static void tb_pin_page_layers(NSView *view) {
  if (!view.layer) {
    return;
  }
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  tb_pin_flipped_layers(view.layer, 0);
  [CATransaction commit];
}

static CALayer *tb_find_picture(CALayer *layer, int depth) {
  for (CALayer *sub in layer.sublayers) {
    if (sub.geometryFlipped) {
      return sub;
    }
    CALayer *found = depth < 6 ? tb_find_picture(sub, depth + 1) : nil;
    if (found) {
      return found;
    }
  }
  return nil;
}

// The size of the layer Chromium shows the page's picture in, for the dump:
// the scripted app's check that it stays the size of the view (false when
// there's none yet).
bool tb_view_picture_size(void *nativeView, double *width, double *height) {
  NSView *view = (__bridge NSView *)nativeView;
  CALayer *picture = view.layer ? tb_find_picture(view.layer, 0) : nil;
  if (!picture) {
    return false;
  }
  *width = picture.bounds.size.width;
  *height = picture.bounds.size.height;
  return true;
}

// A page's native view placed in a GPUI layout slot. GPUI's coordinates are
// the window's, from the top left, in points; the parent view may not be
// flipped, so the y is turned over.
void tb_view_set_frame(void *nativeView, double x, double y, double width, double height) {
  NSView *view = (__bridge NSView *)nativeView;
  if (!view) {
    return;
  }
  // GPUI places it every frame; AppKit resizing it as well fights that.
  view.autoresizingMask = NSViewNotSizable;
  NSView *parent = view.superview;
  CGFloat nativeY = y;
  if (parent && !parent.isFlipped) {
    nativeY = NSHeight(parent.bounds) - y - height;
  }
  view.frame = NSMakeRect(x, nativeY, MAX(0.0, width), MAX(0.0, height));
  // Its layers take the new size now, so the pin sees it; and once more on
  // the next turn of the loop, in case AppKit moves them again after this.
  [view layoutSubtreeIfNeeded];
  [view.layer layoutIfNeeded];
  tb_pin_page_layers(view);
  // Weak: a page closed meanwhile goes now, not after this.
  __weak NSView *weakView = view;
  dispatch_async(dispatch_get_main_queue(), ^{
    NSView *later = weakView;
    if (later) {
      tb_pin_page_layers(later);
    }
  });
}

void tb_view_set_hidden(void *nativeView, bool hidden) {
  NSView *view = (__bridge NSView *)nativeView;
  view.hidden = hidden;
}

// Moves a page's view into another window's view: its panel was dragged into
// a window of its own, or back. The local keeps the view alive between the
// two: its old superview held the only reference to it.
void tb_view_set_parent(void *nativeView, void *nativeParent) {
  NSView *view = (__bridge NSView *)nativeView;
  NSView *parent = (__bridge NSView *)nativeParent;
  if (!view || !parent || view.superview == parent) {
    return;
  }
  [view removeFromSuperview];
  [parent addSubview:view];
}

// Takes a page's view out of its window for good. Its parent held the only
// reference to it, so it goes, and with it the page: Chromium ends a child
// view's browser when the view goes (CefBrowserHostView's dealloc), without
// asking the window it was in to close, as CloseBrowser does.
void tb_view_remove(void *nativeView) {
  NSView *view = (__bridge NSView *)nativeView;
  [view removeFromSuperview];
}

// A person's clicks and keys in each watched page view, counted as AppKit
// hands them over. After a page sends something to the browser, the next
// needs a new one (panel_rules.rs's LeaveGate): Chromium leaves a click's
// activation with the page when the app makes no window for it, so the page
// could otherwise use one click for a page a second (Codex review, 12 Nov). Keys
// go to the view with the keyboard, clicks to the view under them, and a key
// held down counts once. A press from VoiceOver isn't counted, as AppKit
// never sees it. Weak keys: a page's view going takes its count with it.
static NSMapTable<NSView *, NSNumber *> *g_inputs;

static void tb_note_input(NSView *view) {
  if (!view) {
    return;
  }
  // Found first, counted after: the table can't change while it's walked.
  NSMutableArray<NSView *> *under = [NSMutableArray array];
  for (NSView *watched in g_inputs) {
    if ([view isDescendantOf:watched]) {
      [under addObject:watched];
    }
  }
  for (NSView *watched in under) {
    [g_inputs setObject:@([[g_inputs objectForKey:watched] unsignedLongLongValue] + 1) forKey:watched];
  }
}

void tb_view_watch_input(void *nativeView) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    g_inputs = [NSMapTable weakToStrongObjectsMapTable];
    NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown | NSEventMaskKeyDown;
    [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent *(NSEvent *event) {
      NSWindow *window = event.window;
      if (event.type == NSEventTypeKeyDown) {
        if (event.isARepeat) {
          return event;
        }
        NSResponder *responder = window.firstResponder;
        tb_note_input([responder isKindOfClass:[NSView class]] ? (NSView *)responder : nil);
      } else if (window.contentView) {
        // hitTest takes a point in the view's superview's coordinates.
        NSView *content = window.contentView;
        NSView *frame = content.superview ?: content;
        NSPoint point = [frame convertPoint:event.locationInWindow fromView:nil];
        tb_note_input([content hitTest:point]);
      }
      return event;
    }];
  });
  NSView *view = (__bridge NSView *)nativeView;
  if (view && ![g_inputs objectForKey:view]) {
    [g_inputs setObject:@0 forKey:view];
  }
}

uint64_t tb_view_input_count(void *nativeView) {
  NSView *view = (__bridge NSView *)nativeView;
  return view ? [[g_inputs objectForKey:view] unsignedLongLongValue] : 0;
}

// A scripted app's stand-in for a person's click in the page (the specs'
// clicks come through DevTools, which AppKit never sees).
void tb_view_note_input(void *nativeView) {
  tb_note_input((__bridge NSView *)nativeView);
}

// CEF's renderer focus can stay "focused" while AppKit moves firstResponder
// to GPUI and back. Observe AppKit's actual ownership, not that cached state.
typedef void (*TBPageFocusCallback)(void *);
@interface TBPageFocusWatch : NSObject
@property(nonatomic) TBPageFocusCallback notify;
@property(nonatomic) void *context;
@property(nonatomic) BOOL held;
@end
@implementation TBPageFocusWatch
@end
static NSMapTable<NSView *, TBPageFocusWatch *> *g_pageFocus;

static void tb_page_focus_changed(NSWindow *window) {
  NSResponder *responder = window.firstResponder;
  for (NSView *view in g_pageFocus) {
    if (view.window != window) { continue; }
    TBPageFocusWatch *watch = [g_pageFocus objectForKey:view];
    BOOL held = [responder isKindOfClass:[NSView class]] && [(NSView *)responder isDescendantOf:view];
    BOOL gained = held && !watch.held;
    watch.held = held;
    if (gained) { watch.notify(watch.context); }
  }
}

@interface NSWindow (ThreadbearPageFocus)
- (BOOL)threadbearPageFirstResponder:(NSResponder *)responder;
@end
@implementation NSWindow (ThreadbearPageFocus)
- (BOOL)threadbearPageFirstResponder:(NSResponder *)responder {
  // Swizzled, as NSApplication's CEF sendEvent hook above is: preserve
  // AppKit's result, then notify only the watched preview views in this app.
  BOOL accepted = [self threadbearPageFirstResponder:responder];
  if (accepted) { tb_page_focus_changed(self); }
  return accepted;
}
@end

// Main thread only. The caller keeps context alive until unwatch, which must
// happen before removing the native view or releasing the Rust Shared value.
void tb_view_watch_focus(void *nativeView, TBPageFocusCallback notify, void *context) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    g_pageFocus = [NSMapTable weakToStrongObjectsMapTable];
    Method original = class_getInstanceMethod([NSWindow class], @selector(makeFirstResponder:));
    Method replacement = class_getInstanceMethod([NSWindow class], @selector(threadbearPageFirstResponder:));
    method_exchangeImplementations(original, replacement);
  });
  NSView *view = (__bridge NSView *)nativeView;
  if (!view) { return; }
  TBPageFocusWatch *watch = [TBPageFocusWatch new];
  watch.notify = notify;
  watch.context = context;
  [g_pageFocus setObject:watch forKey:view];
  tb_page_focus_changed(view.window);
}

void tb_view_unwatch_focus(void *nativeView) {
  NSView *view = (__bridge NSView *)nativeView;
  if (view) { [g_pageFocus removeObjectForKey:view]; }
}

// Whether the page's view, or one inside it, has its window's keyboard.
bool tb_view_has_keyboard(void *nativeView) {
  NSView *view = (__bridge NSView *)nativeView;
  NSResponder *responder = view.window.firstResponder;
  return view && [responder isKindOfClass:[NSView class]] && [(NSView *)responder isDescendantOf:view];
}

// Who has the keyboard in the window GPUI's view `nativeView` fills: 0 that
// view, 1 a page's view inside it that's showing, 2 nobody or the window
// itself, 3 a page's view inside it that's hidden, 4 anything else. A page's
// view is a subview of GPUI's (tb_view_set_parent), so "inside it" is a page.
int tb_view_keyboard_holder(void *nativeView) {
  NSView *view = (__bridge NSView *)nativeView;
  NSWindow *window = view.window;
  if (!view || !window) {
    return 2;
  }
  NSResponder *responder = window.firstResponder;
  if (responder == view) {
    return 0;
  }
  if (!responder || responder == window) {
    return 2;
  }
  if ([responder isKindOfClass:[NSView class]] && [(NSView *)responder isDescendantOf:view]) {
    return [(NSView *)responder isHiddenOrHasHiddenAncestor] ? 3 : 1;
  }
  return 4;
}

// Gives GPUI's view its window's keyboard (web_panels.rs says when). It never
// takes it back by itself: it doesn't accept first responder, so a click on
// it leaves the keyboard with a page's view, and once that view's hidden,
// with the window, which beeps at every letter.
bool tb_view_take_keyboard(void *nativeView) {
  NSView *view = (__bridge NSView *)nativeView;
  NSWindow *window = view.window;
  if (!view || !window || window.firstResponder == view) {
    return false;
  }
  return [window makeFirstResponder:view];
}

// A scripted app's stand-in for typing `text` (UTF-8, letters and spaces):
// each character's key down and up handed to the window GPUI's view is in,
// which gives them to whoever has its keyboard, as AppKit does a person's
// keys. A script's own keystrokes go straight into GPUI and never meet AppKit,
// so they can't tell who has the keyboard.
void tb_view_send_keys(void *nativeView, const char *text) {
  NSView *view = (__bridge NSView *)nativeView;
  NSWindow *window = view.window;
  NSString *all = text ? [NSString stringWithUTF8String:text] : nil;
  if (!window || !all) {
    return;
  }
  // US keyboard key codes, which is all the input context reads besides the
  // characters themselves.
  static const unsigned short codes[26] = {0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9, 13, 7, 16, 6};
  for (NSUInteger i = 0; i < all.length; i++) {
    NSString *one = [all substringWithRange:NSMakeRange(i, 1)];
    unichar c = [one.lowercaseString characterAtIndex:0];
    // Delete (U+007F) as the Backspace key, so a script can take words out.
    unsigned short code = (c >= 'a' && c <= 'z') ? codes[c - 'a'] : c == 0x7f ? 51 : 49;
    for (int down = 1; down >= 0; down--) {
      NSEvent *event = [NSEvent keyEventWithType:(down ? NSEventTypeKeyDown : NSEventTypeKeyUp)
                                        location:NSZeroPoint
                                   modifierFlags:0
                                       timestamp:[[NSProcessInfo processInfo] systemUptime]
                                    windowNumber:window.windowNumber
                                         context:nil
                                      characters:one
                     charactersIgnoringModifiers:one
                                       isARepeat:NO
                                         keyCode:code];
      [window sendEvent:event];
    }
  }
}

// A scripted shortcut through NSWindow, including performKeyEquivalent and
// native first-responder delivery. It never posts to the system event tap.
// Bits: command=1, control=2, shift=4, option=8.
void tb_view_send_shortcut(void *nativeView, unsigned short code, const char *characters, unsigned int modifiers) {
  NSView *view = (__bridge NSView *)nativeView;
  NSWindow *window = view.window;
  NSString *text = characters ? [NSString stringWithUTF8String:characters] : nil;
  if (!window || !text) { return; }
  NSEventModifierFlags flags = 0;
  if (modifiers & 1) { flags |= NSEventModifierFlagCommand; }
  if (modifiers & 2) { flags |= NSEventModifierFlagControl; }
  if (modifiers & 4) { flags |= NSEventModifierFlagShift; }
  if (modifiers & 8) { flags |= NSEventModifierFlagOption; }
  if (code >= 123 && code <= 126) { flags |= NSEventModifierFlagFunction | NSEventModifierFlagNumericPad; }
  for (int down = 1; down >= 0; down--) {
    NSEvent *event = [NSEvent keyEventWithType:(down ? NSEventTypeKeyDown : NSEventTypeKeyUp)
                                      location:NSZeroPoint modifierFlags:flags
                                     timestamp:[[NSProcessInfo processInfo] systemUptime]
                                  windowNumber:window.windowNumber context:nil
                                    characters:text charactersIgnoringModifiers:text
                                     isARepeat:NO keyCode:code];
    [window sendEvent:event];
  }
}

// A scripted app's stand-in for a person's click at (x, y) in the window
// GPUI's view `nativeView` fills, in GPUI's coordinates (from the top left):
// a mouse down and up handed to the window, which hit-tests and delivers them
// as AppKit does a person's, so a page's view under the point gets them the
// way it gets a real click (first-mouse rules and all). DevTools' clicks skip
// all of that, which is why they never met the missed clicks in a panel.
// Returns what AppKit hit there and each view in that branch, with its frame
// in the window (from the bottom left), for the scripted app to report:
// malloc'd, freed by the caller with free().
static void tb_describe_layer(CALayer *l, NSMutableString *out, int depth, int level) {
  [out appendFormat:@"%*slayer %@ frame(%.1f,%.1f %.1fx%.1f) flipped %d%s\n", depth * 2, "", NSStringFromClass([l class]), l.frame.origin.x, l.frame.origin.y, l.frame.size.width, l.frame.size.height, l.geometryFlipped, l.masksToBounds ? " masks" : ""];
  if (level < 5) {
    for (CALayer *sub in l.sublayers) {
      tb_describe_layer(sub, out, depth + 1, level + 1);
    }
  }
}

static void tb_describe(NSView *v, NSMutableString *out, int depth) {
  NSRect r = [v convertRect:v.bounds toView:nil];
  [out appendFormat:@"%*s%@ %s window(%.1f,%.1f %.1fx%.1f) frame(%.1f,%.1f %.1fx%.1f)%s\n", depth * 2, "", NSStringFromClass([v class]), v.isFlipped ? "flipped" : "", r.origin.x, r.origin.y, r.size.width, r.size.height, v.frame.origin.x, v.frame.origin.y, v.frame.size.width, v.frame.size.height, v.hidden ? " hidden" : ""];
  if (@available(macOS 11.0, *)) {
    NSEdgeInsets inset = v.safeAreaInsets;
    if (inset.top || inset.bottom || inset.left || inset.right) {
      [out appendFormat:@"%*s  safe area insets top %.1f bottom %.1f\n", depth * 2, "", inset.top, inset.bottom];
    }
  }
  if (v.layer) {
    tb_describe_layer(v.layer, out, depth + 1, 0);
  }
  if (depth < 6) {
    for (NSView *sub in v.subviews) {
      tb_describe(sub, out, depth + 1);
    }
  }
}

char *tb_view_send_click(void *nativeView, double x, double y) {
  NSView *view = (__bridge NSView *)nativeView;
  NSWindow *window = view.window;
  if (!window) {
    return strdup("no window");
  }
  NSPoint inView = NSMakePoint(x, view.isFlipped ? y : NSHeight(view.bounds) - y);
  NSPoint inWindow = [view convertPoint:inView toView:nil];
  NSView *frame = window.contentView.superview ?: window.contentView;
  NSView *hit = [window.contentView hitTest:[frame convertPoint:inWindow fromView:nil]];
  // Counted as a person's click, as the input monitor counts one: events
  // handed straight to the window never pass it (LeaveGate, panel_rules.rs).
  tb_note_input(hit);
  for (int down = 1; down >= 0; down--) {
    NSEvent *event = [NSEvent mouseEventWithType:(down ? NSEventTypeLeftMouseDown : NSEventTypeLeftMouseUp)
                                        location:inWindow
                                   modifierFlags:0
                                       timestamp:[[NSProcessInfo processInfo] systemUptime]
                                    windowNumber:window.windowNumber
                                         context:nil
                                     eventNumber:0
                                      clickCount:1
                                        pressure:(down ? 1.0 : 0.0)];
    [window sendEvent:event];
  }
  NSMutableString *out = [NSMutableString stringWithFormat:@"at window (%.1f, %.1f), key %d, hit %@\n", inWindow.x, inWindow.y, window.isKeyWindow, NSStringFromClass([hit class])];
  for (NSView *sub in view.subviews) {
    tb_describe(sub, out, 0);
  }
  return strdup(out.UTF8String);
}

@interface TBMenuTarget : NSObject
@property(nonatomic) NSInteger chosen;
- (void)pick:(NSMenuItem *)item;
@end

@implementation TBMenuTarget
- (void)pick:(NSMenuItem *)item {
  self.chosen = item.tag;
}
@end

// A native menu at (x, y) in a window's view, in GPUI's coordinates (from the
// top left), for a menu that has to come up over a web page's view: GPUI draws
// its own menus inside the window, under the page. Blocks while it's open, as
// an NSMenu does, and returns the item chosen, or -1. An empty title is a
// separator; a symbol is an SF Symbol's name, shown beside the title as the
// Swift app's menus show theirs.
int tb_popup_menu(void *nativeView, double x, double y, const char *const *titles, const char *const *symbols, const char *const *tips, const bool *checked, int count) {
  NSView *view = (__bridge NSView *)nativeView;
  if (!view) {
    return -1;
  }
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@""];
  menu.autoenablesItems = NO;
  TBMenuTarget *target = [TBMenuTarget new];
  target.chosen = -1;
  for (int i = 0; i < count; i++) {
    const char *title = titles[i];
    if (!title || !title[0]) {
      [menu addItem:[NSMenuItem separatorItem]];
      continue;
    }
    NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:[NSString stringWithUTF8String:title] action:@selector(pick:) keyEquivalent:@""];
    item.target = target;
    item.tag = i;
    item.state = checked[i] ? NSControlStateValueOn : NSControlStateValueOff;
    if (symbols[i] && symbols[i][0]) {
      item.image = [NSImage imageWithSystemSymbolName:[NSString stringWithUTF8String:symbols[i]] accessibilityDescription:nil];
    }
    if (tips[i] && tips[i][0]) {
      item.toolTip = [NSString stringWithUTF8String:tips[i]];
    }
    [menu addItem:item];
  }
  CGFloat nativeY = view.isFlipped ? y : NSHeight(view.bounds) - y;
  [menu popUpMenuPositioningItem:nil atLocation:NSMakePoint(x, nativeY) inView:view];
  return (int)target.chosen;
}

// The app's bundle id, for the helpers' ids, or NULL when it isn't running
// from a bundle (a cargo build the specs start). The string is the bundle's
// and lives as long as it.
const char *tb_main_bundle_identifier(void) {
  NSString *identifier = [[NSBundle mainBundle] bundleIdentifier];
  return identifier ? identifier.UTF8String : NULL;
}
