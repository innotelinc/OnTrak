// Export a compact JSON summary of the program Ghidra just analysed.
//
// ontrak-genie drives `analyzeHeadless ... -postScript ExportSummary.java <out>`
// and parses what this writes. Keeping the summary small is deliberate: the
// model needs architecture, entry points, imports, a function sample and
// strings that look like indicators, not a 40 MB decompiler dump.
//
// @category Innotel
// @runtime Java

import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.DataIterator;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.FunctionIterator;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolType;

import java.io.FileWriter;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public class ExportSummary extends GhidraScript {

    private static final int MAX_FUNCTIONS = 60;
    private static final int MAX_IMPORTS = 60;
    private static final int MAX_EXPORTS = 60;
    private static final int MAX_STRINGS = 200;

    private static String quote(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }

    private static String array(List<String> values) {
        StringBuilder out = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                out.append(',');
            }
            out.append(quote(values.get(i)));
        }
        return out.append(']').toString();
    }

    @Override
    protected void run() throws Exception {
        long started = System.currentTimeMillis();
        String[] args = getScriptArgs();
        if (args.length < 1) {
            printerr("ExportSummary.java requires an output path");
            return;
        }

        Set<String> functionNames = new LinkedHashSet<>();
        List<String> entryPoints = new ArrayList<>();
        List<String> imports = new ArrayList<>();
        List<String> exports = new ArrayList<>();
        List<String> strings = new ArrayList<>();
        int functionCount = 0;

        FunctionIterator functions = currentProgram.getFunctionManager().getFunctions(true);
        while (functions.hasNext()) {
            Function function = functions.next();
            functionCount++;
            if (functionNames.size() < MAX_FUNCTIONS) {
                functionNames.add(function.getName());
            }
        }

        for (Address address : currentProgram.getSymbolTable().getExternalEntryPointIterator()) {
            if (entryPoints.size() >= 10) {
                break;
            }
            entryPoints.add(address.toString());
        }

        SymbolIterator external = currentProgram.getSymbolTable().getExternalSymbols();
        while (external.hasNext() && imports.size() < MAX_IMPORTS) {
            Symbol symbol = external.next();
            imports.add(symbol.getName());
        }

        SymbolIterator symbols = currentProgram.getSymbolTable().getAllSymbols(true);
        while (symbols.hasNext() && exports.size() < MAX_EXPORTS) {
            Symbol symbol = symbols.next();
            if (symbol.getSymbolType() == SymbolType.FUNCTION && symbol.isGlobal() && !symbol.isExternal()) {
                exports.add(symbol.getName());
            }
        }

        DataIterator data = currentProgram.getListing().getDefinedData(true);
        while (data.hasNext() && strings.size() < MAX_STRINGS) {
            Data item = data.next();
            try {
                StringDataInstance instance = StringDataInstance.getStringDataInstance(item);
                if (instance == null) {
                    continue;
                }
                String value = instance.getStringValue();
                if (value == null || value.isEmpty()) {
                    continue;
                }
                value = value.trim();
                if (value.length() >= 4) {
                    strings.add(value.length() > 200 ? value.substring(0, 200) : value);
                }
            } catch (Exception ignored) {
                // Not every defined datum is a string; skipping is the point.
            }
        }

        StringBuilder json = new StringBuilder();
        json.append('{');
        json.append("\"program\":").append(quote(currentProgram.getName())).append(',');
        json.append("\"languageId\":").append(quote(currentProgram.getLanguageID().getIdAsString())).append(',');
        json.append("\"architecture\":").append(quote(currentProgram.getLanguage().getProcessor().toString())).append(',');
        json.append("\"endian\":").append(quote(currentProgram.getMemory().isBigEndian() ? "big" : "little")).append(',');
        json.append("\"compiler\":").append(quote(currentProgram.getCompilerSpec().getCompilerSpecID().getIdAsString())).append(',');
        json.append("\"entryPoints\":").append(array(entryPoints)).append(',');
        json.append("\"functionCount\":").append(functionCount).append(',');
        json.append("\"functions\":").append(array(new ArrayList<>(functionNames))).append(',');
        json.append("\"imports\":").append(array(imports)).append(',');
        json.append("\"exports\":").append(array(exports)).append(',');
        json.append("\"strings\":").append(array(strings)).append(',');
        json.append("\"analyzedAt\":").append(quote(new java.util.Date().toString())).append(',');
        json.append("\"durationMs\":").append(System.currentTimeMillis() - started);
        json.append('}');

        try (FileWriter writer = new FileWriter(args[0])) {
            writer.write(json.toString());
        }
        println("ExportSummary wrote " + args[0]);
    }
}
