
# calibre-node

calibre-node is a lightweight Node.js module that provides ebook conversion capabilities by wrapping the Calibre CLI tools. It offers built-in queuing and threading to efficiently handle multiple conversions with ease. Please note that this module does not handle the actual conversion algorithms; it interfaces with Calibre's CLI utilities to perform conversions.

## Installation

First, ensure that you have Calibre installed on your system, as this module relies on its conversion tools. You can download Calibre from the [official website](https://calibre-ebook.com/download_linux). Make sure that the `ebook-convert` command is available in your system's PATH.

To test if Calibre is installed correctly, run the following command in your terminal:

```bash
ebook-convert --version
```

To install calibre-node, use npm:

```bash
npm install calibre-node
```

## Usage

After installing both Calibre and calibre-node, you can start converting ebooks in your Node.js application.

```javascript
const calibre = require('calibre-node');

// Convert an ebook
calibre.convert({
    input: './input/book.pdf',
    output: './output/book.epub',
    delete: false,
    silent: true, // this package's console output
    verbose: 'low' // calibre conversion output verbosity
}).then(response => {
    console.log('Conversion successful:', response);
}).catch(error => {
    console.error('Conversion failed:', error);
});
```

In this example, a PDF file at `./input/book.pdf` is converted to an EPUB file at `./output/book.epub`. Set the `delete` option to `true` if you want to remove the input file after conversion, and `silent` to `false` if you want verbose logging.

### Conversion Options

The `convert` function accepts an object with the following properties:

- `input` (string, required): The path to the input file.
- `output` (string, required): The path where the output file will be saved, including the desired extension.
- `delete` (boolean, optional): Whether to delete the input file after conversion. Default is `false`.
- `silent` (boolean, optional): If set to `true`, suppresses calibre-node package's console output. Default is `true`.
- `verbose` ("low" | "med" | "high", optional): Sets the verbosity level of calibre conversion output. Default is `"low"`.

Additional conversion options supported by Calibre can also be included. Refer to the [Calibre conversion documentation](https://manual.calibre-ebook.com/generated/en/ebook-convert.html) for a full list of parameters.

### Conversion Result

The conversion promise resolves with a result object containing:

- `success` (boolean): Indicates whether the conversion was successful
- `filePath` (string): The full path where the converted file was saved
- `filename` (string): The name of the converted file without extension
- `extension` (string): The file extension of the converted file
- `error` (string, optional): Error message if the conversion failed

```typescript
interface ConversionResult {
    success: boolean;
    filePath: string;
    filename: string;
    extension: string;
    error?: string;
}
```

### Managing the Thread Pool

You can control the number of concurrent conversions by setting the thread pool size:

```javascript
calibre.setPoolSize(2); // Allows two conversions to run simultaneously, Default is 1
```

Conversions exceeding the pool size will be queued and processed when threads become available.

## Contributing

This module is open-source under the MIT license. Contributions, issues, and feature requests are welcome! Feel free to fork and submit pull requests.

## Credits

calibre-node is an improvement over the [node-ebook-converter](https://www.npmjs.com/package/node-ebook-converter) package.
