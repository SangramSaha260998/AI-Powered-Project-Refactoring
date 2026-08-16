# Project Creation Error Log

This file tracks errors encountered during project creation and their solutions.
**Refer to this BEFORE creating any project to avoid ALL these errors.**

---

## 🎯 MY COMMITMENT TO ERROR-FREE PROJECT CREATION

When you ask me to create a project, I will:

### ✅ **Before Creating**
1. Review this entire error log
2. Check the pre-creation checklist
3. Plan the project structure to avoid common pitfalls

### ✅ **During Creation**
1. Configure `tsconfig.json` correctly with ALL fixes below
2. Configure `package.json` with correct dependencies
3. Set up proper Angular compiler options
4. Use correct import syntax
5. Place decorators correctly
6. Use proper injection tokens
7. **ALWAYS** type-cast event targets
8. **ALWAYS** accept $event parameter in HostListener methods
9. **NEVER** use optional chaining on non-nullable types

### ✅ **Before Delivering**
1. Run `npm install` to ensure all dependencies are installed
2. Run `ng build` to verify NO compilation errors
3. Run `ng serve` to ensure the app starts correctly
4. **FIX ANY ERRORS** before delivering the project

### ✅ **My Promise**
I will **NEVER** deliver a project that throws any of the errors documented in this file.

---

## 🔴 BUILD-TIME ERRORS (Errors that FAIL the build)

### **ERROR 1: TS5101 - baseUrl Deprecated (TypeScript 7.0)**
```
TS5101: Option 'baseUrl' is deprecated and will stop functioning in TypeScript 7.0.
Specify compilerOption '"ignoreDeprecations": "6.0"' to silence this error.
```

**Solution - tsconfig.json:**
```json
{
  "compilerOptions": {
    "baseUrl": "./",
    "ignoreDeprecations": "6.0",
    // ... other options
  }
}
```

**⚠️ ALWAYS ADD `"ignoreDeprecations": "6.0"` WHEN USING `baseUrl`!**

---

### **ERROR 2: TS2345 - EventTarget Type Mismatch**
```
TS2345: Argument of type 'EventTarget | null' is not assignable to parameter of type 'HTMLElement'.
Type 'null' is not assignable to type 'HTMLElement'.
```

**Wrong Code:**
```typescript
@HostListener('document:click', ['$event.target'])
onClick(target: HTMLElement) { // ❌ target can be null
```

**Solution:**
```typescript
@HostListener('document:click', ['$event'])
onClick(event: Event) {
  const target = event.target as HTMLElement; // ✅ Type-cast with null check
  if (target && !this.elementRef.nativeElement.contains(target)) {
    this.clickOutside.emit();
  }
}
```

**Rule: ALWAYS use `$event` instead of `$event.target` and type-cast manually!**

---

### **ERROR 3: TS2554 - HostListener Method Arguments**
```
TS2554: Expected 0 arguments, but got 1.
```

**Wrong Code:**
```typescript
@HostListener('input', ['$event']) onInput(): void { // ❌ No parameter defined
  // ...
}
```

**Solution:**
```typescript
@HostListener('input', ['$event']) onInput(event: Event): void { // ✅ Accept parameter
  // ...
}
```

**Rule: ALWAYS add parameter to method when using `$event` in HostListener!**

---

### **ERROR 4: NG8107 - Optional Chain on Non-Nullable Type**
```
NG8107: The left side of this optional chain operation does not include 'null' or 'undefined'
in its type, therefore the '?.' operator can be replaced with the '.' operator.
```

**Wrong Code:**
```html
{{ loginDetails?.name }}  <!-- ❌ loginDetails is never null -->
```

**Solution:**
```html
<!-- Option 1: Use . if type is never null -->
{{ loginDetails.name }}

<!-- Option 2: Make the type nullable -->
<!-- In component.ts -->
loginDetails: User | null = null;

<!-- Option 3: Suppress with @angular/compiler option -->
```

**Solution - angular.json (suppress warning):**
```json
{
  "angularCompilerOptions": {
    "extendedDiagnostics": {
      "checks": {
        "optionalChainNotNullable": "suppress"
      }
    }
  }
}
```

**Rule: Either remove `?.` or make the type nullable!**

---

## 🔴 CRITICAL: Module Resolution Errors (TS2792)

### **Error Pattern**
```
TS2792: Cannot find module '@angular/core'.
```

### **Solution**
```json
{
  "compilerOptions": {
    "moduleResolution": "node",
    "baseUrl": "./",
    "ignoreDeprecations": "6.0",
    "paths": {
      "@app/*": ["src/app/*"],
      "@core/*": ["src/app/core/*"],
      "@shared/*": ["src/app/shared/*"],
      "@store/*": ["src/app/store/*"]
    },
    "skipLibCheck": true
  }
}
```

---

## 🔴 CRITICAL: Angular Import Resolution Errors (NG1010)

### **Error Pattern**
```
NG1010: 'imports' must be an array of components, directives, pipes, or NgModules.
```

### **Solution**
```typescript
// Ensure all imports are Angular components/modules
import { CommonModule } from '@angular/common';
import { RouterModule, RouterOutlet } from '@angular/router';

@Component({
  imports: [CommonModule, RouterModule, RouterOutlet] // ✅ Valid
})
export class MyComponent {}
```

---

## 🔴 CRITICAL: Injection Token Errors (NG2003)

### **Solution**
```typescript
// Ensure @Injectable() decorator
@Injectable({ providedIn: 'root' })
export class MyService {}

// Use @Inject for custom tokens
constructor(@Inject(MAT_DIALOG_DATA) private data: any) {}

// For ElementRef, use @Optional() and @Self()
constructor(@Optional() @Self() private el: ElementRef) {}
```

---

## 🔴 CRITICAL: Decorator Placement Errors (TS1206)

### **Solution**
```typescript
// ✅ Correct - Decorator before parameter
constructor(
  private dialogRef: MatDialogRef,
  @Inject(MAT_DIALOG_DATA) private data: any
) {}
```

---

## 📋 PRE-CREATION CHECKLIST

### **1. tsconfig.json (MUST HAVE ALL OF THESE)**
```json
{
  "compileOnSave": false,
  "compilerOptions": {
    "baseUrl": "./",
    "ignoreDeprecations": "6.0",
    "outDir": "./dist/out-tsc",
    "forceConsistentCasingInFileNames": true,
    "strict": false,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": false,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "sourceMap": true,
    "declaration": false,
    "downlevelIteration": true,
    "experimentalDecorators": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "target": "ES2022",
    "module": "ES2022",
    "useDefineForClassFields": false,
    "lib": ["ES2022", "dom"],
    "paths": {
      "@app/*": ["src/app/*"],
      "@core/*": ["src/app/core/*"],
      "@shared/*": ["src/app/shared/*"],
      "@store/*": ["src/app/store/*"]
    },
    "skipLibCheck": true
  },
  "angularCompilerOptions": {
    "enableI18nLegacyMessageIdFormat": false,
    "strictInjectionParameters": true,
    "strictInputAccessModifiers": true,
    "strictTemplates": false
  }
}
```

### **2. Code Rules (MUST FOLLOW)**

#### **HostListener Rules:**
```typescript
// ✅ ALWAYS use $event (not $event.target)
@HostListener('document:click', ['$event'])
onClick(event: Event) {
  const target = event.target as HTMLElement; // Type-cast manually
  if (target && !this.elementRef.nativeElement.contains(target)) {
    this.clickOutside.emit();
  }
}

// ✅ ALWAYS add parameter to method
@HostListener('input', ['$event'])
onInput(event: Event): void {
  // ...
}
```

#### **Optional Chaining Rules:**
```typescript
// ✅ If type is never null, use . instead of ?.
{{ loginDetails.name }}

// ✅ If type can be null, keep ?. but ensure type is correct
loginDetails: User | null = null;
{{ loginDetails?.name }}
```

#### **Injection Rules:**
```typescript
// ✅ Always @Injectable() for services
@Injectable({ providedIn: 'root' })
export class MyService {}

// ✅ Always @Inject for custom tokens
constructor(@Inject(MAT_DIALOG_DATA) private data: any) {}
```

### **3. Package.json (REQUIRED DEPENDENCIES)**
```json
{
  "dependencies": {
    "@angular/animations": "^17.0.0",
    "@angular/common": "^17.0.0",
    "@angular/compiler": "^17.0.0",
    "@angular/core": "^17.0.0",
    "@angular/forms": "^17.0.0",
    "@angular/material": "^17.0.0",
    "@angular/platform-browser": "^17.0.0",
    "@angular/platform-browser-dynamic": "^17.0.0",
    "@angular/router": "^17.0.0",
    "rxjs": "~7.8.0",
    "tslib": "^2.6.0",
    "zone.js": "~0.14.0"
  },
  "devDependencies": {
    "@angular-devkit/build-angular": "^17.0.0",
    "@angular/cli": "^17.0.0",
    "@angular/compiler-cli": "^17.0.0",
    "@types/node": "^20.0.0",
    "typescript": "~5.2.0"
  }
}
```

### **4. Build Verification (BEFORE DELIVERING)**
```bash
npm install
ng build
ng serve
```

**ALL THREE MUST PASS WITH ZERO ERRORS!**

---

## 🚨 QUICK REFERENCE - COMMON MISTAKES TO AVOID

| Mistake | Fix |
|---------|-----|
| Missing `ignoreDeprecations: "6.0"` | Add to tsconfig.json when using baseUrl |
| Using `$event.target` in HostListener | Use `$event` and cast manually |
| Method without parameter for `$event` | Add parameter: `method(event: Event)` |
| Using `?.` on non-nullable type | Use `.` or make type nullable |
| Missing `@Injectable()` | Add decorator to service classes |
| Missing `@Inject()` | Use for custom injection tokens |
| Missing `skipLibCheck: true` | Add to tsconfig.json |
| Wrong `moduleResolution` | Set to `"node"` |
