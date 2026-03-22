grammar MyDsl

hidden terminal WS: /\s+/;

entry Model:
    elements+=Reservation*;

Reservation:
    'reserve' resource=ID 'at' time=STRING;

terminal ID: /[a-zA-Z_][a-zA-Z0-9_]*/;
terminal STRING: /"[^"]*"|'[^']*'/;