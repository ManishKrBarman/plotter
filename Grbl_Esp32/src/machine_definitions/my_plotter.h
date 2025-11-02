#pragma once

#include "..\Machine.h"

// Basic 2-axis plotter using DRV8825 and servo pen

#define MACHINE_NAME            "My_2Axis_Plotter"
#define N_AXIS                  2   // X, Y only
#define USE_SERVO_PEN           1

// Stepper driver pins (example for ESP32 DevKit V1)
#define X_STEP_PIN              26
#define X_DIRECTION_PIN         25
#define X_DISABLE_PIN           27

#define Y_STEP_PIN              14
#define Y_DIRECTION_PIN         12
#define Y_DISABLE_PIN           13

// Servo for pen up/down
#define SERVO_PEN_PIN           15
#define SERVO_PEN_UP_ANGLE      40
#define SERVO_PEN_DOWN_ANGLE    90

// Limit switches (optional)
#define X_LIMIT_PIN             33
#define Y_LIMIT_PIN             32

// Steps per mm (tune later)
#define DEFAULT_X_STEPS_PER_MM  80.0
#define DEFAULT_Y_STEPS_PER_MM  80.0

// Feed rates
#define DEFAULT_X_MAX_RATE      2000.0
#define DEFAULT_Y_MAX_RATE      2000.0

// Acceleration
#define DEFAULT_X_ACCELERATION  100.0
#define DEFAULT_Y_ACCELERATION  100.0

// Jerk
#define DEFAULT_X_JERK          10.0
#define DEFAULT_Y_JERK          10.0

// Optional: set origin / homing directions
#define INVERT_X_DIR false
#define INVERT_Y_DIR true

void userInit() {
    Serial.println("My Plotter initialized");
}