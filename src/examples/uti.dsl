farmaco Noradrenalina { tipo "Vasopressor" dose_maxima 2.0 "mcg/kg/min" incremento_seguro 0.05 "mcg/kg/min" }
farmaco Propofol { tipo "Sedativo" dose_maxima 4.0 "mg/kg/h" incremento_seguro 0.5 "mg/kg/h" }
farmaco Vasopressina { tipo "Vasopressor" dose_maxima 0.04 "U/min" incremento_seguro 0.01 "U/min" }

regra_seguranca: bloquear_incremento Propofol se "PAM < 60" ("Risco de Hipotensao Severa")
regra_seguranca: bloquear_incremento Noradrenalina se "FC > 130" ("Risco de Fibrilacao")