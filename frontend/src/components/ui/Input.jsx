export default function Input(props) {
    return (
        <input
            {...props}
            className={`border border-border rounded-lg px-2 py-1${props.className ? " " + props.className : ""}`}
        />
    );
}

export function IPInput(props) {
    return (
        <input
            type="text"
            pattern="^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$"
            inputMode="numeric"
            placeholder="Enter IP address"
            {...props}
            className={`border border-border rounded-lg px-2 py-1${props.className ? " " + props.className : ""}`}
        />
    );
}