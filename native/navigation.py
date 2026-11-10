from __future__ import absolute_import

import math
import time


class CameraState(object):
    def __init__(self, yaw=0.72, pitch=0.68, distance=500.0, target=None,
                 invert_orbit_x=True, invert_orbit_y=True):
        self.yaw = float(yaw)
        self.pitch = float(pitch)
        self.distance = float(distance)
        self.target = list(target or [0.0, 0.0, 0.0])
        self.invert_orbit_x = bool(invert_orbit_x)
        self.invert_orbit_y = bool(invert_orbit_y)
        self.history = []

    def snapshot(self):
        return (self.yaw, self.pitch, self.distance, tuple(self.target))

    def remember_view(self, state=None):
        state = self.snapshot() if state is None else state
        if not self.history or self.history[-1] != state:
            self.history.append(state)
            self.history[:] = self.history[-16:]

    def previous_view(self):
        if not self.history:
            return False
        self.yaw, self.pitch, self.distance, target = self.history.pop()
        self.target = list(target)
        return True

    def project(self, point, width, height, fov=48.0):
        """Project a renderer-world point to top-left viewport pixel coordinates."""
        eye = self.eye()
        forward = [self.target[i] - eye[i] for i in range(3)]
        length = math.sqrt(sum(v * v for v in forward)) or 1.0
        forward = [v / length for v in forward]
        right = [-forward[2], 0.0, forward[0]]
        length = math.sqrt(sum(v * v for v in right)) or 1.0
        right = [v / length for v in right]
        upward = [right[1] * forward[2] - right[2] * forward[1],
                  right[2] * forward[0] - right[0] * forward[2],
                  right[0] * forward[1] - right[1] * forward[0]]
        delta = [float(point[i]) - eye[i] for i in range(3)]
        depth = sum(delta[i] * forward[i] for i in range(3))
        if depth <= 1e-12:
            return None
        width, height = max(1, width), max(1, height)
        factor = height / (2.0 * depth * math.tan(math.radians(fov) / 2.0))
        return (width / 2.0 + sum(delta[i] * right[i] for i in range(3)) * factor,
                height / 2.0 - sum(delta[i] * upward[i] for i in range(3)) * factor,
                depth)

    def orbit(self, delta_x, delta_y, sensitivity=0.008):
        horizontal = -delta_x if self.invert_orbit_x else delta_x
        vertical = -delta_y if self.invert_orbit_y else delta_y
        self.yaw += horizontal * sensitivity
        self.pitch = max(0.08, min(math.pi * 0.49, self.pitch + vertical * sensitivity))

    def pan(self, delta_x, delta_y, scale=1.0):
        factor = max(self.distance, 1.0) * 0.0017 * scale
        right_x = math.cos(self.yaw)
        right_z = -math.sin(self.yaw)
        forward_x = math.sin(self.yaw)
        forward_z = math.cos(self.yaw)
        self.target[0] -= delta_x * factor * right_x
        self.target[2] -= delta_x * factor * right_z
        self.target[0] += delta_y * factor * forward_x
        self.target[2] += delta_y * factor * forward_z

    def fit_bounds(self, bounds, stack_bottom=0.0, stack_top=0.0, aspect=1.0, fov=48.0):
        min_x, min_y, max_x, max_y = bounds
        self.target = [(min_x + max_x) * 0.5, (stack_bottom + stack_top) * 0.5,
                       -(min_y + max_y) * 0.5]
        radius = max(0.001, math.sqrt((max_x - min_x) ** 2 + (max_y - min_y) ** 2
                                     + (stack_top - stack_bottom) ** 2) * 0.5)
        half_vertical = math.radians(fov) * 0.5
        half_horizontal = math.atan(math.tan(half_vertical) * max(float(aspect), 0.01))
        self.distance = radius * 1.08 / math.sin(min(half_vertical, half_horizontal))
        return radius

    def zoom(self, wheel_steps):
        self.distance = max(0.001, min(1e12, self.distance * math.exp(max(-20.0, min(20.0, -float(wheel_steps) * 0.12)))))

    def eye(self):
        horizontal = self.distance * math.cos(self.pitch)
        return [
            self.target[0] + horizontal * math.sin(self.yaw),
            self.target[1] + self.distance * math.sin(self.pitch),
            self.target[2] + horizontal * math.cos(self.yaw),
        ]


class InteractionUpdate(object):
    def __init__(self, changed=False, entered_fast=False, left_fast=False, mode='',
                 delta_x=0.0, delta_y=0.0):
        self.changed = changed
        self.entered_fast = entered_fast
        self.left_fast = left_fast
        self.mode = mode
        self.delta_x = float(delta_x)
        self.delta_y = float(delta_y)


class PointerStateMachine(object):
    def __init__(self, mouse_threshold=2.0, touch_threshold=6.0,
                 restore_delay=0.180, clock=None):
        self.mouse_threshold = float(mouse_threshold)
        self.touch_threshold = float(touch_threshold)
        self.restore_delay = float(restore_delay)
        self.clock = clock or time.monotonic
        self.pressed = False
        self.dragging = False
        self.fast = False
        self.mode = ''
        self.start_x = 0.0
        self.start_y = 0.0
        self.last_x = 0.0
        self.last_y = 0.0
        self.restore_at = None

    def press(self, x, y, mode='orbit'):
        self.pressed = True
        self.dragging = False
        self.mode = mode
        self.start_x = self.last_x = float(x)
        self.start_y = self.last_y = float(y)
        self.restore_at = None
        return InteractionUpdate(mode=mode)

    def move(self, x, y, touch=False):
        if not self.pressed:
            return InteractionUpdate(mode=self.mode)
        x = float(x)
        y = float(y)
        threshold = self.touch_threshold if touch else self.mouse_threshold
        if not self.dragging and math.hypot(x - self.start_x, y - self.start_y) < threshold:
            return InteractionUpdate(mode=self.mode)
        entered = not self.fast
        self.dragging = True
        self.fast = True
        delta_x = x - self.last_x
        delta_y = y - self.last_y
        self.last_x = x
        self.last_y = y
        return InteractionUpdate(
            changed=(delta_x != 0.0 or delta_y != 0.0),
            entered_fast=entered,
            mode=self.mode,
            delta_x=delta_x,
            delta_y=delta_y,
        )

    def release(self):
        was_dragging = self.dragging
        self.pressed = False
        self.dragging = False
        if self.fast:
            self.restore_at = self.clock() + self.restore_delay
        return InteractionUpdate(changed=was_dragging, mode=self.mode)

    def wheel(self):
        entered = not self.fast
        self.fast = True
        self.restore_at = self.clock() + self.restore_delay
        return InteractionUpdate(changed=True, entered_fast=entered, mode='zoom')

    def poll(self):
        if self.fast and not self.pressed and self.restore_at is not None:
            if self.clock() >= self.restore_at:
                self.fast = False
                self.restore_at = None
                return InteractionUpdate(changed=True, left_fast=True, mode=self.mode)
        return InteractionUpdate(mode=self.mode)
