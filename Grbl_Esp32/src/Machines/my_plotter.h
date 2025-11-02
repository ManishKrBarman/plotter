#pragma once
// clang-format off

/*
    my_plotter.h
    Custom 2-axis plotter (X/Y) with pen-lift servo

    Board: ESP32 DevKit V1 (esp32doit-devkit-v1)
    Drivers: DRV8825 step/dir drivers for X and Y
    Pen servo on GPIO13 driven via User Analog Output (M67/M68)

    Notes
    - Keep N_AXIS at default (3) even if only X/Y are used.
    - Configure steps/mm, direction invert, max rate, accel, etc. via $ settings at runtime.
    - Servo is controlled with M67 E0 Q{duty} at 50 Hz
        e.g. M67 E0 Q5   -> ~1ms pulse  (pen up)
             M67 E0 Q10  -> ~2ms pulse  (pen down)
*/

#define MACHINE_NAME            "MY_PLOTTER"

// --------------------
// Stepper pin mapping
// --------------------
// Choose safe GPIOs that don't interfere with boot strapping
// X Axis
#define X_STEP_PIN              GPIO_NUM_26
#define X_DIRECTION_PIN         GPIO_NUM_27

// Y Axis
#define Y_STEP_PIN              GPIO_NUM_33
#define Y_DIRECTION_PIN         GPIO_NUM_32

// Shared enable for DRV8825 (active low on most modules)
#define STEPPERS_DISABLE_PIN    GPIO_NUM_25

// Optional: Limit switches (comment out if not used)
// #define X_LIMIT_PIN             GPIO_NUM_34   // input only pin, requires external pull-up
// #define Y_LIMIT_PIN             GPIO_NUM_35   // input only pin, requires external pull-up

// --------------------
// Spindle (disabled)
// --------------------
// We are using a servo for pen control via User Analog Output, so disable spindle
#define SPINDLE_TYPE            SpindleType::NONE

// --------------------
// Probe (not used)
// --------------------
// #define PROBE_PIN               GPIO_NUM_4

// --------------------
// User I/O - Servo control
// --------------------
// Use User Analog Output channel 0 as a 50Hz PWM for RC servo on GPIO13
// Control with: M67 E0 Q5  (≈1ms pulse ~5% duty)
//               M67 E0 Q7.5 (≈1.5ms ~7.5% duty)
//               M67 E0 Q10 (≈2ms ~10% duty)
#define USER_ANALOG_PIN_0        GPIO_NUM_13
#define USER_ANALOG_PIN_0_FREQ   50   // Hz

// If you also want quick ON/OFF pins for accessories, you can add USER_DIGITAL_PIN_x here
// #define USER_DIGITAL_PIN_0     GPIO_NUM_2

// --------------------
// Optional control inputs
// --------------------
// Uncomment if physical buttons are wired (inputs need external pull-ups on ESP32 input-only pins)
// #define CONTROL_RESET_PIN       GPIO_NUM_34
// #define CONTROL_FEED_HOLD_PIN   GPIO_NUM_36
// #define CONTROL_CYCLE_START_PIN GPIO_NUM_39
// #define CONTROL_SAFETY_DOOR_PIN GPIO_NUM_35

// End of my_plotter.h
