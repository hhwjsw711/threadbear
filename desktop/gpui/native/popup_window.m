// Non-activating floating child panel support for Threadbear's reusable
// dropdown popup window (popup_host.rs). Keeps dropdown menus composited above
// native CEF/WebKit/AVKit child views without hiding them, and forwards
// Escape/Up/Down/Return plus outside clicks cleanly.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <stdbool.h>
#import <stdint.h>

typedef enum : uint32_t {
  TBPopupEventDismiss = 0,
  TBPopupEventMouseOut = 1,
  TBPopupEventUp = 2,
  TBPopupEventDown = 3,
  TBPopupEventConfirm = 4,
} TBPopupEventKind;

typedef void (*tb_popup_event_fn)(uint64_t gen, uint32_t kind);

@interface TBPopupMonitor : NSObject
@property (nonatomic, weak) NSWindow *panel;
@property (nonatomic, weak) NSWindow *owner;
@property (nonatomic, assign) NSRect toggleAnchor;
@property (nonatomic, assign) BOOL swallowToggleAnchor;
@property (nonatomic, strong) id localMonitor;
@property (nonatomic, strong) id resignActiveObserver;
@property (nonatomic, strong) id resignKeyObserver;
@property (nonatomic, strong) id ownerCloseObserver;
@property (nonatomic, assign) uint64_t activeGen;
@property (nonatomic, assign) tb_popup_event_fn onEvent;
@end

@implementation TBPopupMonitor

+ (instancetype)shared {
  static TBPopupMonitor *instance = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    instance = [[TBPopupMonitor alloc] init];
  });
  return instance;
}

- (void)stop {
  if (self.localMonitor) {
    [NSEvent removeMonitor:self.localMonitor];
    self.localMonitor = nil;
  }
  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  if (self.resignActiveObserver) {
    [nc removeObserver:self.resignActiveObserver];
    self.resignActiveObserver = nil;
  }
  if (self.resignKeyObserver) {
    [nc removeObserver:self.resignKeyObserver];
    self.resignKeyObserver = nil;
  }
  if (self.ownerCloseObserver) {
    [nc removeObserver:self.ownerCloseObserver];
    self.ownerCloseObserver = nil;
  }
  self.panel = nil;
  self.owner = nil;
  self.toggleAnchor = NSZeroRect;
  self.swallowToggleAnchor = NO;
  self.activeGen = 0;
  self.onEvent = NULL;
}

- (void)fireDismiss:(TBPopupEventKind)kind {
  uint64_t gen = self.activeGen;
  tb_popup_event_fn fn = self.onEvent;
  [self stop];
  if (fn && gen != 0) {
    fn(gen, (uint32_t)kind);
  }
}

- (void)fireKey:(TBPopupEventKind)kind {
  uint64_t gen = self.activeGen;
  tb_popup_event_fn fn = self.onEvent;
  if (fn && gen != 0) {
    fn(gen, (uint32_t)kind);
  }
}

- (void)watchPanel:(NSWindow *)panel
             owner:(NSWindow *)owner
      toggleAnchor:(NSRect)toggleAnchor
      swallowToggle:(BOOL)swallowToggle
               gen:(uint64_t)gen
           onEvent:(tb_popup_event_fn)onEvent {
  [self stop];
  self.panel = panel;
  self.owner = owner;
  self.toggleAnchor = toggleAnchor;
  self.swallowToggleAnchor = swallowToggle;
  self.activeGen = gen;
  self.onEvent = onEvent;

  __weak TBPopupMonitor *weakSelf = self;
  NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown |
                     NSEventMaskOtherMouseDown | NSEventMaskKeyDown;
  self.localMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask
                                                            handler:^NSEvent *(NSEvent *event) {
    TBPopupMonitor *strongSelf = weakSelf;
    if (!strongSelf || !strongSelf.panel || strongSelf.activeGen != gen) {
      return event;
    }
    if (event.type == NSEventTypeKeyDown) {
      // Forward menu navigation keys while keeping activation on the owner
      // window. Block plain typing/Backspace from editing inputs behind the
      // menu, and dismiss the menu before letting Cmd/Ctrl shortcuts through.
      NSEventModifierFlags cmdOrCtrl =
          event.modifierFlags &
          (NSEventModifierFlagCommand | NSEventModifierFlagControl);
      if (cmdOrCtrl != 0) {
        [strongSelf fireDismiss:TBPopupEventDismiss];
        return event;
      }
      NSEventModifierFlags opt = event.modifierFlags & NSEventModifierFlagOption;
      if (opt == 0) {
        switch (event.keyCode) {
          case 53: // Escape
            [strongSelf fireDismiss:TBPopupEventDismiss];
            return nil;
          case 126: // Up arrow
            [strongSelf fireKey:TBPopupEventUp];
            return nil;
          case 125: // Down arrow
            [strongSelf fireKey:TBPopupEventDown];
            return nil;
          case 36: // Return
          case 76: // Numpad Enter
            [strongSelf fireKey:TBPopupEventConfirm];
            return nil;
          default:
            break;
        }
      }
      return nil;
    }
    if (event.window != strongSelf.panel) {
      BOOL onToggle = NO;
      if (strongSelf.swallowToggleAnchor && event.type == NSEventTypeLeftMouseDown &&
          event.window == strongSelf.owner && strongSelf.owner.contentView) {
        NSView *content = strongSelf.owner.contentView;
        NSPoint pt = [content convertPoint:event.locationInWindow fromView:nil];
        onToggle = NSPointInRect(pt, strongSelf.toggleAnchor);
      }
      [strongSelf fireDismiss:TBPopupEventMouseOut];
      if (onToggle) {
        return nil;
      }
    }
    return event;
  }];

  NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
  self.resignActiveObserver =
      [nc addObserverForName:NSApplicationDidResignActiveNotification
                      object:nil
                       queue:nil
                  usingBlock:^(__unused NSNotification *note) {
        [weakSelf fireDismiss:TBPopupEventDismiss];
      }];
  self.resignKeyObserver =
      [nc addObserverForName:NSWindowDidResignKeyNotification
                      object:owner
                       queue:nil
                  usingBlock:^(__unused NSNotification *note) {
        [weakSelf fireDismiss:TBPopupEventDismiss];
      }];
  self.ownerCloseObserver =
      [nc addObserverForName:NSWindowWillCloseNotification
                      object:owner
                       queue:nil
                  usingBlock:^(__unused NSNotification *note) {
        [weakSelf fireDismiss:TBPopupEventDismiss];
      }];
}

@end

static NSScreen *tb_screen_for_rect(NSRect anchorScreen, NSWindow *owner) {
  NSPoint center = NSMakePoint(NSMidX(anchorScreen), NSMidY(anchorScreen));
  for (NSScreen *screen in [NSScreen screens]) {
    if (NSPointInRect(center, screen.frame)) {
      return screen;
    }
  }
  return owner.screen ?: [NSScreen mainScreen];
}

static NSRect tb_popup_screen_frame(NSWindow *owner, double anchor_x,
                                    double anchor_y, double anchor_w,
                                    double anchor_h, double width,
                                    double height, double pad) {
  NSView *content = owner.contentView;
  NSRect bounds = content ? content.bounds : NSZeroRect;
  CGFloat originY = (content && content.isFlipped)
                        ? anchor_y
                        : (bounds.size.height - anchor_y - anchor_h);
  NSRect inContent = NSMakeRect(anchor_x, originY, anchor_w, anchor_h);
  NSRect inWindow =
      content ? [content convertRect:inContent toView:nil] : inContent;
  NSRect anchorScreen = [owner convertRectToScreen:inWindow];

  NSScreen *screen = tb_screen_for_rect(anchorScreen, owner);
  NSRect visible = screen ? screen.visibleFrame : NSMakeRect(0, 0, 1440, 900);

  const CGFloat gap = 4.0;
  const CGFloat edgeMargin = 8.0;

  // Align the visible menu's left edge with the trigger's left edge; flip to
  // right-aligned if it would extend past the right edge of the display.
  CGFloat x = anchorScreen.origin.x - pad;
  if (x + width - pad > NSMaxX(visible) - edgeMargin) {
    x = NSMaxX(anchorScreen) + pad - width;
  }
  CGFloat minX = visible.origin.x + edgeMargin - pad;
  CGFloat maxX = NSMaxX(visible) - edgeMargin + pad - width;
  if (maxX >= minX) {
    if (x < minX) x = minX;
    if (x > maxX) x = maxX;
  }

  // Open below the trigger; flip above if the visible menu would go off-screen.
  CGFloat y = anchorScreen.origin.y - gap - height + pad;
  if (y + pad < visible.origin.y + edgeMargin) {
    CGFloat above = NSMaxY(anchorScreen) + gap - pad;
    if (above + height - pad <= NSMaxY(visible) - edgeMargin) {
      y = above;
    }
  }
  CGFloat minY = visible.origin.y + edgeMargin - pad;
  CGFloat maxY = NSMaxY(visible) - edgeMargin + pad - height;
  if (maxY >= minY) {
    if (y < minY) y = minY;
    if (y > maxY) y = maxY;
  }

  return NSMakeRect(floor(x), floor(y), ceil(width), ceil(height));
}

static void tb_popup_style_panel(NSWindow *panel, NSView *panelView,
                                 NSWindow *owner) {
  if ([panel isKindOfClass:[NSPanel class]]) {
    NSPanel *p = (NSPanel *)panel;
    [p setBecomesKeyOnlyIfNeeded:YES];
    [p setFloatingPanel:YES];
  }
  // Strip AppKit's titled/full-size frame chrome so macOS cannot paint a dark
  // window frame or enforce a titled minimum size around the transparent popup.
  NSResponder *responder = panel.firstResponder;
  if (panel.styleMask != NSWindowStyleMaskNonactivatingPanel) {
    panel.styleMask = NSWindowStyleMaskNonactivatingPanel;
  }
  if (responder && responder != panel && panel.firstResponder != responder) {
    [panel makeFirstResponder:responder];
  }
  panel.titleVisibility = NSWindowTitleHidden;
  panel.titlebarAppearsTransparent = YES;
  panel.opaque = NO;
  panel.backgroundColor = [NSColor clearColor];
  panel.hasShadow = NO;
  panel.animationBehavior = NSWindowAnimationBehaviorNone;
  [panel invalidateShadow];
  [panel setReleasedWhenClosed:NO];
  panel.level = owner ? owner.level : NSPopUpMenuWindowLevel;
  if (panel.contentView) {
    panel.contentView.wantsLayer = YES;
    panel.contentView.layer.backgroundColor = [NSColor clearColor].CGColor;
  }
  if (panelView) {
    panelView.wantsLayer = YES;
    panelView.layer.backgroundColor = [NSColor clearColor].CGColor;
  }
}

void tb_popup_place(void *panel_ns_view, void *owner_ns_view, double anchor_x,
                    double anchor_y, double anchor_w, double anchor_h,
                    double width, double height, double pad, uint64_t gen,
                    bool swallow_toggle, tb_popup_event_fn on_event) {
  NSView *panelView = (__bridge NSView *)panel_ns_view;
  NSView *ownerView = (__bridge NSView *)owner_ns_view;
  NSWindow *panel = panelView.window;
  NSWindow *owner = ownerView.window;
  if (!panel || !owner || !owner.isVisible) return;

  NSView *content = owner.contentView;
  NSRect bounds = content ? content.bounds : NSZeroRect;
  CGFloat originY = (content && content.isFlipped)
                        ? anchor_y
                        : (bounds.size.height - anchor_y - anchor_h);
  NSRect anchorInContent = NSMakeRect(anchor_x, originY, anchor_w, anchor_h);
  [[TBPopupMonitor shared] watchPanel:panel
                                owner:owner
                         toggleAnchor:anchorInContent
                        swallowToggle:swallow_toggle ? YES : NO
                                  gen:gen
                              onEvent:on_event];

  // Defer styleMask/setFrame/ordering to the next main-queue turn so AppKit's
  // synchronous resize callbacks run after GPUI releases its &mut App borrow.
  // Keep alphaValue = 0 while GPUI measures and paints the final exact size so
  // the user never sees a stretched first frame or macOS pop-in animation.
  __weak NSWindow *weakPanel = panel;
  __weak NSView *weakPanelView = panelView;
  __weak NSWindow *weakOwner = owner;
  dispatch_async(dispatch_get_main_queue(), ^{
    TBPopupMonitor *monitor = [TBPopupMonitor shared];
    if (monitor.activeGen != gen) return;
    NSWindow *p = weakPanel;
    NSView *pv = weakPanelView;
    NSWindow *o = weakOwner;
    if (!p || !o || !o.isVisible) return;
    tb_popup_style_panel(p, pv, o);
    p.alphaValue = 0.0;
    NSRect frame = tb_popup_screen_frame(o, anchor_x, anchor_y, anchor_w,
                                         anchor_h, width, height, pad);
    [p setFrame:frame display:YES];
    if (p.parentWindow != o) {
      if (p.parentWindow) {
        [p.parentWindow removeChildWindow:p];
      }
      [o addChildWindow:p ordered:NSWindowAbove];
    }
    [p orderWindow:NSWindowAbove relativeTo:o.windowNumber];
  });
}

void tb_popup_reposition(void *panel_ns_view, void *owner_ns_view,
                         double anchor_x, double anchor_y, double anchor_w,
                         double anchor_h, double width, double height,
                         double pad, uint64_t gen) {
  NSView *panelView = (__bridge NSView *)panel_ns_view;
  NSView *ownerView = (__bridge NSView *)owner_ns_view;
  NSWindow *panel = panelView.window;
  NSWindow *owner = ownerView.window;
  if (!panel || !owner || !owner.isVisible) return;

  __weak NSWindow *weakPanel = panel;
  __weak NSWindow *weakOwner = owner;
  dispatch_async(dispatch_get_main_queue(), ^{
    TBPopupMonitor *monitor = [TBPopupMonitor shared];
    if (monitor.activeGen != gen) return;
    NSWindow *p = weakPanel;
    NSWindow *o = weakOwner;
    if (!p || !o || !o.isVisible) return;
    NSRect frame = tb_popup_screen_frame(o, anchor_x, anchor_y, anchor_w,
                                         anchor_h, width, height, pad);
    [p setFrame:frame display:YES];
  });
}

void tb_popup_reveal(void *panel_ns_view, uint64_t gen) {
  if (!panel_ns_view) return;
  NSView *panelView = (__bridge NSView *)panel_ns_view;
  NSWindow *panel = panelView.window;
  if (!panel) return;
  __weak NSWindow *weakPanel = panel;
  dispatch_async(dispatch_get_main_queue(), ^{
    TBPopupMonitor *monitor = [TBPopupMonitor shared];
    if (monitor.activeGen != gen) return;
    NSWindow *p = weakPanel;
    if (!p) return;
    p.alphaValue = 1.0;
  });
}

void tb_popup_hide(void *panel_ns_view) {
  [[TBPopupMonitor shared] stop];
  if (!panel_ns_view) return;
  NSView *panelView = (__bridge NSView *)panel_ns_view;
  NSWindow *panel = panelView.window;
  if (!panel) return;
  panel.alphaValue = 0.0;
  if (panel.parentWindow) {
    [panel.parentWindow removeChildWindow:panel];
  }
  [panel orderOut:nil];
}
